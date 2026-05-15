// ====================================================================
// OccupancyCounter テスト用ダッシュボードサーバー
//   - POST /ingest/headcount で Android アプリからの人数を受信
//   - device_id → 会議室 のマッピングで滞在人数を反映
//   - GET / で会議室管理風ダッシュボードを表示
//   - GET /api/state で現在状態を JSON で取得（フロントから3秒毎にポーリング）
//   - CORS 有効（GitHub Pages からのfetch対応）
// ====================================================================

const express = require("express");
const path = require("path");
require("./services/env-loader").loadEnv();

// W2: Azure Speech 連携サービス
const jobProcessor    = require("./services/job-processor");
const audioPublisher  = require("./services/audio-publisher");
const speakerProfiles = require("./services/speaker-profiles");
// 優先度4: functions/ 統合 - Azure Storage Queue コンシューマー
const queueConsumer   = require("./services/queue-consumer");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = String(process.env.TESTDASHBOARD_API_KEY || "").trim();

// ─── CORS (GitHub Pages からのfetchを許可) ──────────────────────
// 必要に応じて Origin を絞り込み可能。'*' にしておけば任意オリジンから可。
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use((req, res, next) => {
  if (!requiresApiKey(req) || isApiKeyAuthorized(req)) return next();
  return res.status(401).json({ ok: false, error: "api key required" });
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ─── multer (multipart受信) ─────────────────────────────────────
const multer = require("multer");
const fs = require("fs");
const recordingsDir = path.join(__dirname, "recordings");
if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, recordingsDir),
  filename:    (_req, file, cb) => {
    const ts = Date.now();
    cb(null, `${ts}-${file.originalname}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 } // 200MB
});

// ─── 会議室マスタ（IDを変えるとレイアウトに反映される） ────────────────
const ROOMS = [
  { id: "large",   name: "大会議室",   floor: "3F", capacity: 10, nextLabel: "10:00 【社内会議】人事MT" },
  { id: "medium",  name: "中会議室",   floor: "2F", capacity: 6,  nextLabel: "17:30 【社内会議】CDA役職者会議" },
  { id: "small",   name: "小会議室",   floor: "2F", capacity: 2,  nextLabel: "16:00 安田 鍾哲 作業報告" },
  { id: "booth",   name: "個別ブース", floor: "1F", capacity: 1,  nextLabel: "" },
];

// ─── デバイス → 会議室マッピング ───────────────────────────────────
// 各会議室にIoTデバイス(Android)を1台ずつ設置する想定。
// 各デバイスの device_id (MAC形式) をここで会議室にマッピング。
// アプリ側で device_id を以下と一致させると、対応する会議室の数値が更新される。
let deviceMap = {
  "AA:11:11:11:11:11": "large",   // 大会議室   (3F・定員10)
  "3F:A8:91:0C:7B:E2": "medium",  // 中会議室   (2F・定員 6)  ← ユーザー指定
  "CC:33:33:33:33:33": "small",   // 小会議室   (2F・定員 2)
  "DD:44:44:44:44:44": "booth",   // 個別ブース (1F・定員 1)
};

// ─── 状態（メモリ保持） ────────────────────────────────────────────
const state = {
  rooms: Object.fromEntries(ROOMS.map(r => [r.id, {
    headcount: 0,
    confidence: "—",
    lastUpdate: null,
    deviceId: null,
  }])),
  history: ROOMS.reduce((acc, r) => { acc[r.id] = []; return acc; }, {}),
};

// ─── POST /ingest/headcount ─ Android からの送信を受信 ────────────
app.post("/ingest/headcount", (req, res) => {
  const { device_id, headcount, confidence } = req.body || {};

  if (!device_id || typeof headcount !== "number") {
    return res.status(400).json({ ok: false, error: "device_id と headcount(int) は必須です" });
  }

  const roomId = deviceMap[device_id];
  if (!roomId) {
    console.warn(`[ingest] 未登録のdevice_id: ${device_id} → 受信したが反映先なし`);
    return res.status(202).json({
      ok: false,
      message: `device_id ${device_id} は未登録です。POST /api/devices でマッピングしてください。`,
    });
  }

  const room = state.rooms[roomId];
  room.headcount = Math.max(0, Math.floor(headcount));
  room.confidence = confidence || "—";
  room.lastUpdate = new Date().toISOString();
  room.deviceId = device_id;

  state.history[roomId].push({ t: room.lastUpdate, n: room.headcount, c: room.confidence });
  if (state.history[roomId].length > 30) state.history[roomId].shift();

  console.log(`[ingest] ${device_id} → ${roomId} : headcount=${headcount} (${confidence})`);
  return res.json({ ok: true, room: roomId, headcount: room.headcount });
});

// ─── GET /api/state ─ ダッシュボードのポーリング用 ────────────────
app.get("/api/state", (_req, res) => {
  res.json({
    serverTime: new Date().toISOString(),
    rooms: ROOMS.map(meta => ({
      ...meta,
      ...state.rooms[meta.id],
    })),
    deviceMap,
    history: state.history,
  });
});

// ─── POST /api/devices ─ デバイスマッピングを動的に登録 ────────────
app.post("/api/devices", (req, res) => {
  const { device_id, room_id } = req.body || {};
  if (!device_id || !room_id) return res.status(400).json({ ok: false, error: "device_id と room_id は必須" });
  if (!ROOMS.find(r => r.id === room_id)) return res.status(400).json({ ok: false, error: `room_id ${room_id} は存在しません` });
  deviceMap[device_id] = room_id;
  res.json({ ok: true, deviceMap });
});

// ─── DELETE /api/state ─ 全状態リセット（テスト用） ────────────────
app.delete("/api/state", (_req, res) => {
  ROOMS.forEach(r => {
    state.rooms[r.id] = { headcount: 0, confidence: "—", lastUpdate: null, deviceId: null };
    state.history[r.id] = [];
  });
  res.json({ ok: true });
});

// ─── POST /ingest/recording ─ Android からの会議音声受信 ────────────
//   multipart/form-data:
//     - meta : application/json
//     - audio: audio/mp4 (m4a)
const recordings = []; // メモリに保持 (本番は DB)
app.post("/ingest/recording", upload.single("audio"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "audio file missing" });
    }
    let meta = {};
    try {
      // meta は JSON 文字列で来る (multipart の text part)
      meta = req.body.meta ? JSON.parse(req.body.meta) : {};
    } catch (e) {
      return res.status(400).json({ ok: false, error: "meta is not valid JSON" });
    }

    const jobId = meta.job_id || `srv-${Date.now()}`;
    const existingJob = jobProcessor.getJob(jobId);
    if (existingJob) {
      cleanupUploadedFile(req.file);
      return res.status(200).json({
        ok: true,
        job_id: jobId,
        server_job_id: existingJob.jobId,
        exists: true,
        duplicate: true,
        status: existingJob.status,
        message: "job already exists"
      });
    }

    const record = {
      job_id:     jobId,
      device_id:  meta.device_id,
      room_id:    meta.room_id,
      title:      meta.title,
      started_at: meta.started_at,
      ended_at:   meta.ended_at,
      language:   meta.language || "ja-JP",
      file: {
        path: req.file.path,
        size: req.file.size,
        mimetype: req.file.mimetype,
        originalName: req.file.originalname
      },
      receivedAt: new Date().toISOString(),
      status: "received"
    };
    recordings.unshift(record);
    if (recordings.length > 100) recordings.length = 100;

    console.log(
      `[recording] received jobId=${jobId} device=${meta.device_id} room=${meta.room_id} ` +
      `size=${(req.file.size / 1024).toFixed(1)}KB title="${meta.title}"`
    );

    // W2: 非同期で Azure Speech 処理を開始 (mock or real)
    jobProcessor.startJob({
      jobId,
      audioFile: req.file.path,
      meta: {
        device_id:  meta.device_id,
        room_id:    meta.room_id,
        title:      meta.title,
        started_at: meta.started_at,
        ended_at:   meta.ended_at,
        language:   meta.language || "ja-JP"
      }
    }).catch(err => console.error("[recording] startJob error", err));

    return res.status(202).json({
      ok: true,
      job_id: jobId,
      server_job_id: jobId,
      exists: true,
      status: "received",
      message: "transcription started"
    });
  } catch (err) {
    console.error("[recording] error", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/recordings - 受信済み録音一覧
app.get("/api/recordings", (_req, res) => {
  res.json({
    ok: true,
    count: recordings.length,
    recordings: recordings.map(r => ({
      job_id: r.job_id,
      device_id: r.device_id,
      room_id: r.room_id,
      title: r.title,
      started_at: r.started_at,
      ended_at: r.ended_at,
      sizeKB: Math.round(r.file.size / 1024),
      receivedAt: r.receivedAt,
      status: r.status
    }))
  });
});

// ─── Speaker profile management ────────────────────────────────
// 事前に話者の声紋 profile を登録し、後段の真の音声話者識別で使用する。
app.get("/api/speaker-profiles", (_req, res) => {
  res.json({
    ok: true,
    profiles: speakerProfiles.listProfiles()
  });
});

app.get("/api/speaker-profiles/:id", (req, res) => {
  const profile = speakerProfiles.getProfile(req.params.id);
  if (!profile) return res.status(404).json({ ok: false, error: "speaker profile not found" });
  res.json({ ok: true, profile });
});

app.post("/api/speaker-profiles", upload.single("audio"), async (req, res) => {
  try {
    const profile = await speakerProfiles.createProfile({
      displayName: req.body.displayName,
      email: req.body.email,
      department: req.body.department,
      locale: req.body.locale || "ja-JP",
      audioFile: req.file?.path || null,
      ignoreMinLength: req.body.ignoreMinLength === "true" || req.body.ignoreMinLength === true
    });
    return res.status(201).json({ ok: true, profile });
  } catch (err) {
    return handleApiError(res, err);
  } finally {
    cleanupUploadedFile(req.file);
  }
});

app.post("/api/speaker-profiles/:id/enroll", upload.single("audio"), async (req, res) => {
  try {
    const profile = await speakerProfiles.enrollProfile(req.params.id, {
      audioFile: req.file?.path || null,
      ignoreMinLength: req.body.ignoreMinLength === "true" || req.body.ignoreMinLength === true
    });
    return res.json({ ok: true, profile });
  } catch (err) {
    return handleApiError(res, err);
  } finally {
    cleanupUploadedFile(req.file);
  }
});

app.post("/api/speaker-profiles/:id/refresh", async (req, res) => {
  try {
    const profile = await speakerProfiles.refreshProfile(req.params.id);
    return res.json({ ok: true, profile });
  } catch (err) {
    return handleApiError(res, err);
  }
});

app.delete("/api/speaker-profiles/:id", async (req, res) => {
  try {
    return res.json(await speakerProfiles.deleteProfile(req.params.id));
  } catch (err) {
    return handleApiError(res, err);
  }
});
// ─── W2: 音声ファイル公開エンドポイント ────────────────────────────
app.get("/public-audio/:token/:filename", audioPublisher.localAudioMiddleware);

// ─── W2: ジョブ状態取得 ─────────────────────────────────────────
app.get("/api/jobs", (req, res) => {
  const lookupId = req.query.jobId || req.query.job_id || req.query.clientJobId || req.query.client_job_id;
  if (lookupId) {
    const job = findJobByAnyId(String(lookupId));
    if (!job) {
      return res.json({
        ok: true,
        exists: false,
        query: String(lookupId),
        job: null
      });
    }
    return res.json({
      ok: true,
      exists: true,
      query: String(lookupId),
      job: jobSummary(job)
    });
  }

  const jobs = jobProcessor.listJobs().map(j => ({
    ...jobSummary(j),
    speakerIdentification: j.speakerIdentification || j.transcript?.speakerIdentification,
    speakerInference: j.speakerInference || j.transcript?.speakerInference,
    transcriptMerger: j.transcriptMerger || j.transcript?.transcriptMerger
  }));
  res.json({ ok: true, count: jobs.length, jobs });
});

app.get("/api/jobs/:jobId", (req, res) => {
  const j = jobProcessor.getJob(req.params.jobId);
  if (!j) return res.status(404).json({ ok: false, error: "job not found" });
  res.json({
    ok: true,
    jobId:     j.jobId,
    status:    j.status,
    createdAt: j.createdAt,
    completedAt: j.completedAt,
    meta:      j.meta,
    error:     j.error,
    mocked:    j.azureSpeech?.mocked,
    speakerIdentification: j.speakerIdentification || j.transcript?.speakerIdentification,
    speakerInference: j.speakerInference || j.transcript?.speakerInference,
    transcriptMerger: j.transcriptMerger || j.transcript?.transcriptMerger,
    publishedUrl:    j.publishedUrl,
    publishExpiresAt:j.publishExpiresAt,
    transcript:      j.transcript,
    minutes: j.minutes ? {
      tokensIn:    j.minutes.tokensIn,
      tokensOut:   j.minutes.tokensOut,
      model:       j.minutes.model,
      mocked:      j.minutes.mocked,
      generatedAt: j.minutes.generatedAt,
      docxSize:    j.minutes.docxSize,
      docxFilename:j.minutes.docxFilename,
      onedrive:    j.minutes.onedrive,
      downloadUrl: `/api/minutes/${j.jobId}/download`,
      markdownUrl: `/api/minutes/${j.jobId}/markdown`
    } : null
  });
});


// W3: minutes download
app.get("/api/minutes/:jobId/download", (req, res) => {
  const j = jobProcessor.getJob(req.params.jobId);
  if (!j) return res.status(404).json({ ok: false, error: "job not found" });
  if (!j.minutes?.docxPath) return res.status(404).json({ ok: false, error: "docx not yet generated" });
  if (!fs.existsSync(j.minutes.docxPath)) return res.status(410).json({ ok: false, error: "docx gone" });
  const filename = j.minutes.docxFilename || `${j.jobId}.docx`;
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`);
  fs.createReadStream(j.minutes.docxPath).pipe(res);
});

// W3: markdown preview
app.get("/api/minutes/:jobId/markdown", (req, res) => {
  const j = jobProcessor.getJob(req.params.jobId);
  if (!j) return res.status(404).json({ ok: false, error: "job not found" });
  if (!j.minutes?.markdown) return res.status(404).json({ ok: false, error: "minutes not yet generated" });
  res.setHeader("Content-Type", "text/markdown; charset=utf-8");
  res.send(j.minutes.markdown);
});

app.get("/healthz", (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

function cleanupUploadedFile(file) {
  if (!file?.path) return;
  fs.promises.unlink(file.path).catch(() => {});
}

function findJobByAnyId(id) {
  if (!id) return null;
  const direct = jobProcessor.getJob(id);
  if (direct) return direct;
  return jobProcessor.listJobs().find(job =>
    job.jobId === id ||
    job.meta?.job_id === id ||
    job.meta?.clientJobId === id ||
    job.meta?.client_job_id === id ||
    job.meta?.androidJobId === id ||
    job.meta?.roomJobId === id
  ) || null;
}

function jobSummary(j) {
  return {
    jobId:        j.jobId,
    serverJobId:  j.jobId,
    clientJobId:  j.meta?.job_id || j.meta?.clientJobId || j.meta?.client_job_id || j.jobId,
    status:       j.status,
    createdAt:    j.createdAt,
    completedAt:  j.completedAt,
    title:        j.meta?.title,
    deviceId:     j.meta?.device_id,
    roomId:       j.meta?.room_id,
    speakerCount: j.transcript?.speakerCount,
    error:        j.error,
    mocked:       j.azureSpeech?.mocked,
    downloadUrl:  j.minutes?.docxPath ? `/api/minutes/${j.jobId}/download` : null,
    markdownUrl:  j.minutes?.markdown ? `/api/minutes/${j.jobId}/markdown` : null
  };
}

function handleApiError(res, err) {
  const status = err.status || 500;
  console.error("[api] error", err);
  return res.status(status).json({ ok: false, error: err.message });
}

function requiresApiKey(req) {
  if (!API_KEY || req.method === "OPTIONS") return false;
  return req.path.startsWith("/api/") ||
    req.path.startsWith("/ingest/") ||
    req.path.startsWith("/public-audio/");
}

function isApiKeyAuthorized(req) {
  const authHeader = String(req.get("authorization") || "");
  const bearer = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
  const provided = String(req.get("x-api-key") || bearer || req.query.api_key || "").trim();
  return provided === API_KEY;
}

// ─── Graceful shutdown ─────────────────────────────────────────
process.on("SIGTERM", () => { queueConsumer.stop(); process.exit(0); });
process.on("SIGINT",  () => { queueConsumer.stop(); process.exit(0); });

app.listen(PORT, "0.0.0.0", () => {
  console.log("OccupancyCounter Test Dashboard");
  console.log(`Listening on http://localhost:${PORT}`);
  console.log("Endpoints:");
  console.log("  POST /ingest/headcount");
  console.log("  POST /ingest/recording (multipart)");
  console.log("  GET  /api/state");
  console.log("  GET  /api/recordings");
  console.log("  GET  /api/jobs / /api/jobs/:jobId");
  console.log("  GET  /api/minutes/:jobId/download (.docx)");
  console.log("  GET  /api/minutes/:jobId/markdown");
  console.log("  GET  /public-audio/:token/:filename");
  console.log(`Speech mock: ${process.env.AZURE_SPEECH_MOCK || "(unset)"}`);
  console.log(`Claude mock: ${process.env.CLAUDE_MOCK || "(unset, will mock if no key)"}`);
  console.log(`API key auth: ${API_KEY ? "enabled" : "disabled"}`);

  // 優先度4: functions/ → Queue → TestDashboard 統合
  queueConsumer.start();
});
