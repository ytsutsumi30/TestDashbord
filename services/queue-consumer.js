// ============================================================
// Azure Storage Queue コンシューマー
// ============================================================
// functions/notifications (Azure Functions) が Azure Storage Queue
// "minutes-jobs" に積んだ Teams 会議記録通知を消費し、
// Graph API でトランスクリプトを取得して job-processor へ渡す。
//
// 環境変数:
//   AZURE_STORAGE_CONNECTION_STRING  ... Azurite / 本番 Storage 接続文字列
//   QUEUE_NAME                       ... キュー名 (デフォルト: minutes-jobs)
//   QUEUE_DLQ_NAME                   ... 失敗退避キュー名 (デフォルト: <QUEUE_NAME>-deadletter)
//   QUEUE_MAX_DEQUEUE_COUNT          ... 最大試行回数 (デフォルト: 5)
//   QUEUE_POLL_INTERVAL_MS           ... ポーリング間隔 ms (デフォルト: 10000)
//   QUEUE_CONSUMER_MOCK              ... "true" でモック動作
// ============================================================

const { QueueServiceClient } = require("@azure/storage-queue");
const graph        = require("./graph");
const jobProcessor = require("./job-processor");

const CONN_STR      = process.env.AZURE_STORAGE_CONNECTION_STRING || "";
const QUEUE_NAME    = process.env.QUEUE_NAME || "minutes-jobs";
const DLQ_NAME      = process.env.QUEUE_DLQ_NAME || `${QUEUE_NAME}-deadletter`;
const MAX_DEQUEUE   = Math.max(1, parseInt(process.env.QUEUE_MAX_DEQUEUE_COUNT || "5", 10));
const POLL_MS       = parseInt(process.env.QUEUE_POLL_INTERVAL_MS || "10000", 10);
const MOCK          = (process.env.QUEUE_CONSUMER_MOCK || "").toLowerCase() === "true";

let _client  = null;
let _dlqClient = null;
let _timer   = null;
let _running = false;

function isMock() {
  return MOCK || !CONN_STR;
}

function _getQueueClient() {
  if (!_client) {
    const svc = QueueServiceClient.fromConnectionString(CONN_STR);
    _client = svc.getQueueClient(QUEUE_NAME);
  }
  return _client;
}

function _getDeadLetterQueueClient() {
  if (!_dlqClient) {
    const svc = QueueServiceClient.fromConnectionString(CONN_STR);
    _dlqClient = svc.getQueueClient(DLQ_NAME);
  }
  return _dlqClient;
}

// ─── メッセージ処理 ──────────────────────────────────────────────
async function _processMessage(msg) {
  // Base64デコード (Azure Storage Queue はメッセージを Base64 でエンコード)
  let body;
  try {
    const decoded = Buffer.from(msg.messageText, "base64").toString("utf8");
    body = JSON.parse(decoded);
  } catch {
    try {
      body = JSON.parse(msg.messageText);
    } catch (e) {
      console.warn("[queue-consumer] failed to parse message:", msg.messageText);
      return false;
    }
  }

  const { meetingId, transcriptId, changeType, receivedAt } = body;
  if (!meetingId || !transcriptId) {
    console.warn("[queue-consumer] missing meetingId/transcriptId:", body);
    return false;
  }

  console.log(`[queue-consumer] processing meetingId=${meetingId} transcriptId=${transcriptId} changeType=${changeType}`);

  // Graph API でトランスクリプトを取得
  let teamsResult;
  try {
    teamsResult = await graph.getTeamsTranscript(meetingId, transcriptId);
  } catch (err) {
    console.error(`[queue-consumer] getTeamsTranscript error: ${err.message}`);
    return false;
  }

  // jobId を生成 (transcriptId の末尾8文字を使う)
  const shortId = transcriptId.replace(/[^a-zA-Z0-9]/g, "").slice(-8) || Date.now().toString(36);
  const jobId   = `teams-${shortId}`;

  // 既に処理済みのジョブなら重複スキップ
  if (jobProcessor.getJob(jobId)) {
    console.log(`[queue-consumer] jobId=${jobId} already exists, skipping`);
    return true;
  }

  // job-processor に渡す meta を組み立て
  const meta = {
    title:        body.title || `Teams会議-${new Date(receivedAt || Date.now()).toLocaleDateString("ja-JP")}`,
    room_id:      body.room_id || "teams",
    device_id:    "teams_webhook",
    started_at:   body.startDateTime || receivedAt || new Date().toISOString(),
    ended_at:     body.endDateTime   || new Date().toISOString(),
    language:     body.language || "ja-JP",
    meetingId,
    transcriptId,
    recordingId:   body.recordingId || body.recording_id || null,
    roomJobId:     body.roomJobId || body.room_job_id || body.androidJobId || body.clientJobId || null
  };

  await jobProcessor.startJobFromTeams({
    jobId,
    segments: teamsResult.segments,
    meta,
    mocked: teamsResult.mocked
  });

  console.log(`[queue-consumer] started job ${jobId} segments=${teamsResult.segments.length} mocked=${teamsResult.mocked}`);
  return true;
}

// ─── ポーリングループ ─────────────────────────────────────────────
async function _poll() {
  if (_running) return;
  _running = true;

  try {
    if (isMock()) {
      // モック時は何もしない (ログも出さない)
      return;
    }

    const queue = _getQueueClient();

    // キューを確実に作成 (存在しない場合のみ)
    try { await queue.createIfNotExists(); } catch { /* 既存なら無視 */ }

    // 最大 5 件ずつ取得
    const resp = await queue.receiveMessages({ numberOfMessages: 5, visibilityTimeout: 60 });
    for (const msg of (resp.receivedMessageItems || [])) {
      const ok = await _processMessage(msg);
      if (ok) {
        // 処理成功 → キューから削除
        await queue.deleteMessage(msg.messageId, msg.popReceipt);
      } else if (shouldDeadLetter(msg)) {
        await deadLetterMessage(queue, msg, "max_dequeue_exceeded");
      } else {
        // 処理失敗 → visibility を即座に戻す (再試行)
        try {
          await queue.updateMessage(msg.messageId, msg.popReceipt, msg.messageText, 0);
        } catch { /* 無視 */ }
      }
    }
  } catch (err) {
    console.error("[queue-consumer] poll error:", err.message);
  } finally {
    _running = false;
  }
}

// ─── 公開 API ─────────────────────────────────────────────────────
/**
 * コンシューマーを開始する。server.js の起動後に1度だけ呼ぶ。
 */
function start() {
  if (_timer) return; // 多重起動防止
  if (isMock()) {
    console.log("[queue-consumer] MOCK mode: polling disabled (no AZURE_STORAGE_CONNECTION_STRING)");
    return;
  }
  console.log(`[queue-consumer] starting poll every ${POLL_MS}ms → queue="${QUEUE_NAME}"`);
  _poll(); // 初回即実行
  _timer = setInterval(_poll, POLL_MS);
}

/**
 * コンシューマーを停止する (graceful shutdown 用)。
 */
function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    console.log("[queue-consumer] stopped");
  }
}

function shouldDeadLetter(msg) {
  return Number(msg.dequeueCount || 1) >= MAX_DEQUEUE;
}

async function deadLetterMessage(queue, msg, reason) {
  const dlq = _getDeadLetterQueueClient();
  await dlq.createIfNotExists();
  const payload = buildDeadLetterPayload(msg, reason);
  await dlq.sendMessage(Buffer.from(JSON.stringify(payload), "utf8").toString("base64"));
  await queue.deleteMessage(msg.messageId, msg.popReceipt);
  console.warn(`[queue-consumer] moved message to ${DLQ_NAME}: reason=${reason} dequeueCount=${msg.dequeueCount || 1}`);
}

function buildDeadLetterPayload(msg, reason) {
  return {
    reason,
    sourceQueue: QUEUE_NAME,
    messageId: msg.messageId || null,
    dequeueCount: Number(msg.dequeueCount || 1),
    deadLetteredAt: new Date().toISOString(),
    messageText: msg.messageText || ""
  };
}

function _setDeadLetterQueueClientForTest(client) {
  const previous = _dlqClient;
  _dlqClient = client;
  return previous;
}

module.exports = {
  start,
  stop,
  isMock,
  _processMessage,
  _poll,
  shouldDeadLetter,
  deadLetterMessage,
  buildDeadLetterPayload,
  _setDeadLetterQueueClientForTest
};

