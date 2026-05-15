// ============================================================
// Job Processor (オーケストレーター)
// ============================================================
// 録音アップロード → Azure Speech → transcript 保存 までを束ねる。
// ============================================================

const fs = require("fs");
const path = require("path");
const audioPublisher = require("./audio-publisher");
const azureSpeech    = require("./azure-speech");
const claude         = require("./claude");
const docxBuilder    = require("./docx-builder");
const graph          = require("./graph");
const speakerInference = require("./speaker-inference");
const speakerIdentification = require("./speaker-identification");
const transcriptMerger = require("./transcript-merger");

// 永続化先: storage/transcripts/<jobId>.json + storage/minutes/<jobId>.docx + storage/jobs/<jobId>.json
const TRANSCRIPTS_DIR = path.join(__dirname, "..", "storage", "transcripts");
const MINUTES_MD_DIR  = path.join(__dirname, "..", "storage", "minutes-md");
const JOBS_DIR        = path.join(__dirname, "..", "storage", "jobs");
if (!fs.existsSync(TRANSCRIPTS_DIR)) fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
if (!fs.existsSync(MINUTES_MD_DIR))  fs.mkdirSync(MINUTES_MD_DIR,  { recursive: true });
if (!fs.existsSync(JOBS_DIR))        fs.mkdirSync(JOBS_DIR,         { recursive: true });

// メモリ内ジョブストア (本番は Azure Table 推奨)
//   key = jobId
//   value = { jobId, status, audioFile, ...meta, transcript? }
const jobStore = new Map();

// ─── ジョブ永続化ヘルパー ─────────────────────────────────────────
/** ジョブ状態を storage/jobs/<jobId>.json に保存する (失敗してもログのみ) */
function persistJob(job) {
  try {
    const p = path.join(JOBS_DIR, `${job.jobId}.json`);
    // audioFile の絶対パスはファイル名だけに変換して保存
    const snapshot = Object.assign({}, job, {
      audioFile: job.audioFile ? path.basename(job.audioFile) : null,
      roomTranscript: undefined
    });
    fs.writeFileSync(p, JSON.stringify(snapshot, null, 2), "utf8");
  } catch (e) {
    console.warn(`[job ${job.jobId}] persist failed: ${e.message}`);
  }
}

/** 起動時に storage/jobs/*.json から既存ジョブを復元する */
function loadPersistedJobs() {
  try {
    const files = fs.readdirSync(JOBS_DIR).filter(f => f.endsWith(".json"));
    let loaded = 0;
    for (const f of files) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(JOBS_DIR, f), "utf8"));
        if (raw.jobId && !jobStore.has(raw.jobId)) {
          jobStore.set(raw.jobId, raw);
          loaded++;
        }
      } catch (_) { /* 壊れたファイルはスキップ */ }
    }
    if (loaded > 0) console.log(`[job-processor] loaded ${loaded} persisted jobs from storage/jobs/`);
  } catch (e) {
    console.warn(`[job-processor] loadPersistedJobs failed: ${e.message}`);
  }
}

// 起動時に復元
loadPersistedJobs();

const STATUS = Object.freeze({
  QUEUED:        "queued",
  PUBLISHING:    "publishing",
  TRANSCRIBING:  "transcribing",
  IDENTIFYING:    "identifying_speakers",
  SUMMARIZING:   "summarizing",
  BUILDING_DOCX: "building_docx",
  UPLOADING:     "uploading_onedrive",
  COMPLETED:     "completed",
  FAILED:        "failed"
});

const TRANSCRIPT_MERGE_WINDOW_SEC = Number(process.env.TRANSCRIPT_MERGE_WINDOW_SEC || 30 * 60);

function getJob(jobId) { return jobStore.get(jobId); }
function listJobs() {
  return Array.from(jobStore.values()).sort((a, b) =>
    (b.createdAt || "").localeCompare(a.createdAt || "")
  );
}

/**
 * 録音ファイルを受信した直後に呼ぶ。
 * 非同期で Azure Speech 処理を開始し、jobId を返す。
 *
 * @param {object} args
 * @param {string} args.jobId
 * @param {string} args.audioFile (絶対パス)
 * @param {object} args.meta  - { device_id, room_id, title, started_at, ended_at, language }
 * @returns {Promise<object>} job state
 */
async function startJob(args) {
  const { jobId, audioFile, meta } = args;
  const job = {
    jobId,
    status: STATUS.QUEUED,
    createdAt: new Date().toISOString(),
    audioFile,
    meta,
    azureSpeech: { mocked: azureSpeech.isMock() },
    error: null,
    transcript: null
  };
  jobStore.set(jobId, job);
  persistJob(job);

  // 非同期に処理開始 (待たない)
  process.nextTick(() => processJob(jobId).catch(err => {
    console.error(`[job ${jobId}] uncaught error`, err);
  }));

  return job;
}

async function processJob(jobId) {
  const job = jobStore.get(jobId);
  if (!job) return;

  try {
    // 1. 音声を公開
    job.status = STATUS.PUBLISHING;
    const published = await audioPublisher.publish(job.audioFile);
    job.publishedUrl = published.url;
    job.publishToken = published.token;
    job.publishExpiresAt = published.expiresAt;
    console.log(`[job ${jobId}] publishing OK url=${published.url}`);

    // 2. Azure Speech へ送信
    job.status = STATUS.TRANSCRIBING;
    persistJob(job);
    const result = await azureSpeech.transcribeAudio({
      audioUrl:    published.url,
      displayName: `meeting-${jobId}`,
      locale:      job.meta?.language || "ja-JP"
    });

    job.status = STATUS.IDENTIFYING;
    persistJob(job);
    const identified = await speakerIdentification.identifyRoomTranscriptSpeakers({
      jobId,
      audioFile: job.audioFile,
      segments: result.segments
    });
    result.segments = identified.segments;
    result.speakerCount = new Set(result.segments.map(s => s.speakerLabel || s.speakerId).filter(Boolean)).size;
    result.wordCount = result.segments.reduce((n, s) => n + String(s.text || "").split(/\s+/).filter(Boolean).length, 0);
    job.speakerIdentification = identified.summary;

    job.transcript = {
      jobUrl:       result.jobUrl,
      speakerCount: result.speakerCount,
      wordCount:    result.wordCount,
      segments:     result.segments,
      completedAt:  new Date().toISOString(),
      speakerIdentification: identified.summary
    };

    // transcript ファイルを永続化
    const outPath = path.join(TRANSCRIPTS_DIR, `${jobId}.json`);
    fs.writeFileSync(outPath, JSON.stringify({
      job: {
        jobId,
        meta: job.meta,
        audioFile: path.basename(job.audioFile),
        createdAt: job.createdAt,
        completedAt: job.transcript.completedAt
      },
      transcript: job.transcript
    }, null, 2), "utf8");
    job.transcriptPath = outPath;

    // 公開 token を即時失効 (ローカルモードの安全策)
    if (job.publishToken) audioPublisher.revoke(job.publishToken);
    console.log(`[job ${jobId}] transcribe completed segments=${result.segments.length} speakers=${result.speakerCount}`);

    // 3. Claude で議事録 Markdown 生成
    job.status = STATUS.SUMMARIZING;
    persistJob(job);
    const summarized = await claude.generateMinutes({
      meta: job.meta,
      segments: result.segments
    });
    summarized.markdown = withTranscriptAppendix(summarized.markdown, result.segments);
    job.minutes = {
      markdown:  summarized.markdown,
      tokensIn:  summarized.tokensIn,
      tokensOut: summarized.tokensOut,
      model:     summarized.model,
      mocked:    summarized.mocked,
      generatedAt: new Date().toISOString()
    };
    const mdPath = path.join(MINUTES_MD_DIR, `${jobId}.md`);
    fs.writeFileSync(mdPath, summarized.markdown, "utf8");
    job.minutes.mdPath = mdPath;
    console.log(`[job ${jobId}] minutes generated chars=${summarized.markdown.length} mocked=${summarized.mocked}`);

    // 4. .docx 生成
    job.status = STATUS.BUILDING_DOCX;
    persistJob(job);
    const docxResult = await docxBuilder.buildDocx({
      jobId,
      meta: job.meta,
      summary: {
        speakerCount: result.speakerCount,
        wordCount: result.wordCount,
        segmentCount: result.segments.length
      },
      markdown: summarized.markdown
    });
    job.minutes.docxPath = docxResult.path;
    job.minutes.docxSize = docxResult.size;
    job.minutes.docxFilename = docxResult.filename;
    console.log(`[job ${jobId}] docx built ${docxResult.path} size=${docxResult.size}B`);

    // 5. OneDrive 自動アップロード (任意・失敗してもJob全体は失敗にしない)
    job.status = STATUS.UPLOADING;
    persistJob(job);
    try {
      // ファイル名に会議室・タイトルを含める (例: medium_週次定例MTG_w3-mock-001.docx)
      const safeTitle = (job.meta?.title || "untitled").substring(0, 40).replace(/[\\\/:*?"<>|#%]/g, "_");
      const friendlyName = `${job.meta?.room_id || "unknown"}_${safeTitle}_${jobId}.docx`;
      const subFolder = job.meta?.room_id || "";

      const ud = await graph.uploadDocxAndShare({
        filePath: docxResult.path,
        filename: friendlyName,
        subFolder
      });
      job.minutes.onedrive = {
        driveItemId: ud.driveItemId,
        webUrl:      ud.webUrl,
        shareUrl:    ud.shareUrl,
        name:        ud.name,
        mocked:      ud.mocked,
        uploadedAt:  new Date().toISOString()
      };
      console.log(`[job ${jobId}] onedrive uploaded mocked=${ud.mocked} url=${ud.webUrl}`);
    } catch (err) {
      console.warn(`[job ${jobId}] OneDrive upload failed (継続): ${err.message}`);
      job.minutes.onedrive = { error: err.message };
    }

    job.status = STATUS.COMPLETED;
    job.completedAt = new Date().toISOString();
    persistJob(job);
  } catch (err) {
    job.status = STATUS.FAILED;
    job.error = err.message;
    persistJob(job);
    console.error(`[job ${jobId}] FAILED: ${err.message}`);
  }
}

/**
 * Teams 文字起こしキュー経由で受信したジョブを開始する。
 * Azure Speech をスキップし、取得済み segments から直接議事録生成を行う。
 *
 * @param {object} args
 * @param {string} args.jobId
 * @param {Array}  args.segments  - [{ start, end, speakerLabel, text }, …]
 * @param {object} args.meta      - { title, room_id, started_at, ended_at, language, meetingId, transcriptId }
 * @param {boolean} [args.mocked]
 * @returns {Promise<object>} job state
 */
async function startJobFromTeams(args) {
  const { jobId, segments, meta, mocked = false, roomTranscript = null } = args;
  const job = {
    jobId,
    status: STATUS.QUEUED,
    createdAt: new Date().toISOString(),
    audioFile: null,
    meta,
    azureSpeech: { mocked: true, skipped: true },
    source: "teams_webhook",
    roomTranscript,
    error: null,
    transcript: null
  };
  jobStore.set(jobId, job);
  persistJob(job);

  process.nextTick(() => processJobFromTeams(jobId, segments, mocked).catch(err => {
    console.error(`[job ${jobId}] uncaught error (Teams)`, err);
  }));

  return job;
}

async function processJobFromTeams(jobId, segments, mocked) {
  const job = jobStore.get(jobId);
  if (!job) return;

  try {
    // 1. transcript を保存 (Azure Speech スキップ)
    job.status = STATUS.TRANSCRIBING;
    persistJob(job);
    job.status = STATUS.IDENTIFYING;
    persistJob(job);
    const identified = await speakerIdentification.identifyTeamsTranscriptSpeakers({ jobId, meta: job.meta, segments });
    segments = identified.segments;
    job.speakerIdentification = identified.summary;

    if (!identified.summary.applied) {
      const inferred = await speakerInference.inferSpeakers({ meta: job.meta, segments });
      segments = inferred.segments;
      job.speakerInference = inferred.summary;
    } else {
      job.speakerInference = null;
    }

    const roomTranscript = job.roomTranscript || findRelatedRoomTranscript(job);
    if (roomTranscript?.segments?.length) {
      const merged = transcriptMerger.mergeTranscripts({
        primarySegments: segments,
        secondarySegments: roomTranscript.segments,
        primaryMeta: job.meta,
        secondaryMeta: roomTranscript.meta,
        primarySource: "teams",
        secondarySource: roomTranscript.source || "room"
      });
      segments = merged.segments;
      job.transcriptMerger = {
        ...merged.summary,
        roomJobId: roomTranscript.jobId || null,
        roomTitle: roomTranscript.meta?.title || null
      };
    } else {
      job.transcriptMerger = {
        applied: false,
        source: "transcript_merger",
        reason: "no_related_room_transcript"
      };
    }

    job.transcript = {
      speakerCount: new Set(segments.map(s => s.speakerLabel)).size,
      wordCount:    segments.reduce((n, s) => n + s.text.split(/\s+/).length, 0),
      segments,
      completedAt: new Date().toISOString(),
      source: "teams_graph_api",
      speakerIdentification: identified.summary,
      speakerInference: job.speakerInference,
      transcriptMerger: job.transcriptMerger
    };

    const outPath = path.join(TRANSCRIPTS_DIR, `${jobId}.json`);
    fs.writeFileSync(outPath, JSON.stringify({
      job: {
        jobId,
        meta: job.meta,
        createdAt: job.createdAt,
        completedAt: job.transcript.completedAt,
        source: "teams_webhook"
      },
      transcript: job.transcript
    }, null, 2), "utf8");
    job.transcriptPath = outPath;
    console.log(`[job ${jobId}] Teams transcript saved segments=${segments.length} speakers=${job.transcript.speakerCount}`);

    // 2. Claude で議事録 Markdown 生成
    job.status = STATUS.SUMMARIZING;
    persistJob(job);
    const summarized = await claude.generateMinutes({ meta: job.meta, segments });
    summarized.markdown = withTranscriptAppendix(summarized.markdown, segments);
    job.minutes = {
      markdown:    summarized.markdown,
      tokensIn:    summarized.tokensIn,
      tokensOut:   summarized.tokensOut,
      model:       summarized.model,
      mocked:      summarized.mocked,
      generatedAt: new Date().toISOString()
    };
    const mdPath = path.join(MINUTES_MD_DIR, `${jobId}.md`);
    fs.writeFileSync(mdPath, summarized.markdown, "utf8");
    job.minutes.mdPath = mdPath;
    console.log(`[job ${jobId}] minutes generated chars=${summarized.markdown.length} mocked=${summarized.mocked}`);

    // 3. .docx 生成 (Teams)
    job.status = STATUS.BUILDING_DOCX;
    persistJob(job);
    const docxResult = await docxBuilder.buildDocx({
      jobId,
      meta: job.meta,
      summary: {
        speakerCount: job.transcript.speakerCount,
        wordCount:    job.transcript.wordCount,
        segmentCount: segments.length
      },
      markdown: summarized.markdown
    });
    job.minutes.docxPath     = docxResult.path;
    job.minutes.docxSize     = docxResult.size;
    job.minutes.docxFilename = docxResult.filename;
    console.log(`[job ${jobId}] docx built ${docxResult.path} size=${docxResult.size}B`);

    // 4. OneDrive 自動アップロード (Teams)
    job.status = STATUS.UPLOADING;
    persistJob(job);
    try {
      const safeTitle    = (job.meta?.title || "untitled").substring(0, 40).replace(/[\\\/:*?"<>|#%]/g, "_");
      const friendlyName = `${job.meta?.room_id || "unknown"}_${safeTitle}_${jobId}.docx`;
      const ud = await graph.uploadDocxAndShare({
        filePath: docxResult.path,
        filename: friendlyName,
        subFolder: job.meta?.room_id || ""
      });
      job.minutes.onedrive = {
        driveItemId: ud.driveItemId,
        webUrl:      ud.webUrl,
        shareUrl:    ud.shareUrl,
        name:        ud.name,
        mocked:      ud.mocked,
        uploadedAt:  new Date().toISOString()
      };
      console.log(`[job ${jobId}] onedrive uploaded mocked=${ud.mocked}`);
    } catch (err) {
      console.warn(`[job ${jobId}] OneDrive upload failed (継続): ${err.message}`);
      job.minutes.onedrive = { error: err.message };
    }

    job.status = STATUS.COMPLETED;
    job.completedAt = new Date().toISOString();
    persistJob(job);
  } catch (err) {
    job.status = STATUS.FAILED;
    job.error = err.message;
    persistJob(job);
    console.error(`[job ${jobId}] FAILED (Teams): ${err.message}`);
  }
}

function withTranscriptAppendix(markdown, segments) {
  const base = String(markdown || "").trim();
  if (/^##\s+文字起こし全文/m.test(base)) return base;
  const rows = (segments || []).map(segment => {
    const time = formatHMS(segment.start);
    const speaker = escapeMarkdownTableCell(segment.speakerLabel || "Unknown");
    const text = escapeMarkdownTableCell(segment.text || "");
    return `| ${time} | ${speaker} | ${text} |`;
  }).join("\n") || "| — | — | 発言なし |";
  const appendix = `## 文字起こし全文\n\n| 時刻 | 話者 | 発言 |\n|---|---|---|\n${rows}`;
  return `${base}\n\n${appendix}\n`;
}

function escapeMarkdownTableCell(value) {
  return String(value)
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

function formatHMS(sec) {
  sec = Math.floor(sec || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function findRelatedRoomTranscript(job) {
  const explicitId = job.meta?.roomJobId || job.meta?.room_job_id || job.meta?.androidJobId || job.meta?.clientJobId;
  if (explicitId) {
    const explicit = loadTranscriptByJobId(explicitId);
    if (explicit?.segments?.length) return explicit;
  }

  const candidates = listJobs()
    .filter(candidate => candidate.jobId !== job.jobId)
    .filter(candidate => candidate.source !== "teams_webhook")
    .filter(candidate => candidate.transcript?.segments?.length)
    .filter(candidate => isRoomMatch(job.meta, candidate.meta))
    .filter(candidate => isTimeMatch(job.meta, candidate.meta))
    .map(candidate => ({
      jobId: candidate.jobId,
      meta: candidate.meta || {},
      segments: candidate.transcript.segments,
      source: "room_recording",
      score: candidateScore(job.meta, candidate.meta)
    }))
    .sort((a, b) => a.score - b.score);

  return candidates[0] || null;
}

function loadTranscriptByJobId(jobId) {
  const fromStore = getJob(jobId);
  if (fromStore?.transcript?.segments?.length) {
    return {
      jobId,
      meta: fromStore.meta || {},
      segments: fromStore.transcript.segments,
      source: fromStore.source === "teams_webhook" ? "teams" : "room_recording"
    };
  }

  const transcriptPath = path.join(TRANSCRIPTS_DIR, `${jobId}.json`);
  if (!fs.existsSync(transcriptPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(transcriptPath, "utf8"));
    if (!raw?.transcript?.segments?.length) return null;
    return {
      jobId,
      meta: raw.job?.meta || {},
      segments: raw.transcript.segments,
      source: raw.job?.source === "teams_webhook" ? "teams" : "room_recording"
    };
  } catch {
    return null;
  }
}

function isRoomMatch(teamsMeta = {}, roomMeta = {}) {
  const teamsRoom = teamsMeta.room_id || teamsMeta.roomId;
  const room = roomMeta.room_id || roomMeta.roomId;
  if (!teamsRoom || !room || teamsRoom === "teams") return false;
  return teamsRoom === room;
}

function isTimeMatch(teamsMeta = {}, roomMeta = {}) {
  const teamsStart = parseTime(teamsMeta.started_at || teamsMeta.startDateTime);
  const teamsEnd = parseTime(teamsMeta.ended_at || teamsMeta.endDateTime);
  const roomStart = parseTime(roomMeta.started_at || roomMeta.startDateTime);
  const roomEnd = parseTime(roomMeta.ended_at || roomMeta.endDateTime);

  if (!teamsStart || !roomStart) return true;
  if (teamsEnd && roomEnd && teamsStart <= roomEnd && roomStart <= teamsEnd) return true;
  return Math.abs((teamsStart - roomStart) / 1000) <= TRANSCRIPT_MERGE_WINDOW_SEC;
}

function candidateScore(teamsMeta = {}, roomMeta = {}) {
  const teamsStart = parseTime(teamsMeta.started_at || teamsMeta.startDateTime);
  const roomStart = parseTime(roomMeta.started_at || roomMeta.startDateTime);
  if (!teamsStart || !roomStart) return Number.MAX_SAFE_INTEGER;
  return Math.abs(teamsStart - roomStart);
}

function parseTime(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : null;
}

module.exports = {
  STATUS,
  startJob,
  processJob,
  startJobFromTeams,
  getJob,
  listJobs,
  withTranscriptAppendix,
  findRelatedRoomTranscript
};
