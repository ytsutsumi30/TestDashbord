// ============================================================
// Audio segment extraction for speaker identification
// ============================================================

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const FFMPEG_BIN = process.env.FFMPEG_BIN || "ffmpeg";
function isMock() {
  return ["SPEAKER_SEGMENT_MOCK", "SPEAKER_RECOGNITION_MOCK", "GRAPH_MOCK"]
    .some(name => (process.env[name] || "").toLowerCase() === "true");
}

function selectRepresentativeSegments(segments, { minDurationSec = 4, maxDurationSec = 120 } = {}) {
  const bySpeaker = new Map();
  for (const segment of segments || []) {
    const speakerKey = segment.speakerId ?? segment.speakerLabel;
    if (speakerKey == null) continue;
    const start = Number(segment.start || 0);
    const end = Number(segment.end || start);
    const duration = Math.max(0, Math.min(maxDurationSec, end - start));
    if (duration <= 0) continue;
    const current = bySpeaker.get(String(speakerKey));
    if (!current || duration > current.duration) {
      bySpeaker.set(String(speakerKey), {
        speakerKey: String(speakerKey),
        speakerId: segment.speakerId,
        speakerLabel: segment.speakerLabel,
        start,
        end: start + duration,
        duration,
        belowMinDuration: duration < minDurationSec
      });
    }
  }
  return Array.from(bySpeaker.values());
}

async function extractSegment({ sourceFile, outputDir, jobId, speakerKey, start, duration }) {
  if (!sourceFile) throw new Error("sourceFile is required");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${sanitize(jobId)}-${sanitize(speakerKey)}.wav`);

  if (isMock() || !isLikelyMediaFile(sourceFile)) {
    fs.writeFileSync(outputPath, Buffer.from(`RIFF mock wav ${jobId} ${speakerKey} ${start} ${duration}`));
    return { path: outputPath, mocked: true };
  }

  await runFfmpeg([
    "-y",
    "-ss", String(Math.max(0, start)),
    "-t", String(Math.max(1, duration)),
    "-i", sourceFile,
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-c:a", "pcm_s16le",
    outputPath
  ]);
  return { path: outputPath, mocked: false };
}

async function extractRepresentativeSegments({ sourceFile, outputDir, jobId, segments, minDurationSec = 4, maxDurationSec = 120, allowShort = false }) {
  const representatives = selectRepresentativeSegments(segments, { minDurationSec, maxDurationSec })
    .filter(segment => allowShort || !segment.belowMinDuration);
  const results = [];
  for (const segment of representatives) {
    const extracted = await extractSegment({
      sourceFile,
      outputDir,
      jobId,
      speakerKey: segment.speakerKey,
      start: segment.start,
      duration: segment.duration
    });
    results.push({ ...segment, audioFile: extracted.path, mocked: extracted.mocked });
  }
  return results;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_BIN, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", code => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg failed with code ${code}: ${stderr.slice(-800)}`));
    });
  });
}

function isLikelyMediaFile(filePath) {
  return /\.(mp4|m4a|wav|mp3|aac|webm|mkv)$/i.test(filePath || "");
}

function sanitize(value) {
  return String(value || "segment").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
}

module.exports = {
  selectRepresentativeSegments,
  isMock,
  extractSegment,
  extractRepresentativeSegments
};
