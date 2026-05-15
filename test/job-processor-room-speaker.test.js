const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "job-room-speaker-"));
process.env.SPEAKER_PROFILES_STORE_PATH = path.join(tempDir, "speaker-profiles.json");
process.env.AZURE_SPEECH_MOCK = "true";
process.env.CLAUDE_MOCK = "true";
process.env.GRAPH_MOCK = "true";
process.env.SPEAKER_RECOGNITION_MOCK = "true";
process.env.SPEAKER_SEGMENT_MOCK = "true";
process.env.SPEAKER_AUDIO_IDENTIFICATION_ENABLED = "true";

const jobProcessor = require("../services/job-processor");
const speakerProfiles = require("../services/speaker-profiles");

const repoRoot = path.resolve(__dirname, "..");

function cleanupJob(jobId) {
  for (const filePath of [
    path.join(repoRoot, "storage", "jobs", `${jobId}.json`),
    path.join(repoRoot, "storage", "transcripts", `${jobId}.json`),
    path.join(repoRoot, "storage", "minutes", `${jobId}.docx`),
    path.join(repoRoot, "storage", "minutes-md", `${jobId}.md`)
  ]) {
    fs.rmSync(filePath, { force: true });
  }
}

async function waitForJob(jobId, expectedStatus, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = jobProcessor.getJob(jobId);
    if (job?.status === expectedStatus) return job;
    if (job?.status === jobProcessor.STATUS.FAILED) {
      throw new Error(`job failed: ${job.error}`);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${jobId} to become ${expectedStatus}`);
}

test("startJob applies speaker profile identification to Android recording transcripts", async (t) => {
  const profileAudioPath = path.join(tempDir, "profile.wav");
  fs.writeFileSync(profileAudioPath, Buffer.from("RIFF profile wav"));
  await speakerProfiles.createProfile({
    displayName: "山田",
    email: "yamada@example.com",
    department: "PSU",
    audioFile: profileAudioPath
  });

  const jobId = `unit-room-speaker-${process.pid}-${Date.now()}`;
  const audioFile = path.join(tempDir, `${jobId}.m4a`);
  fs.writeFileSync(audioFile, Buffer.from("mock android recording"));
  t.after(() => cleanupJob(jobId));

  await jobProcessor.startJob({
    jobId,
    audioFile,
    meta: {
      title: "Android speaker profile test",
      room_id: "large",
      device_id: "AA:11:11:11:11:11",
      started_at: "2026-05-15T09:00:00.000Z",
      ended_at: "2026-05-15T09:05:00.000Z",
      language: "ja-JP"
    }
  });

  const job = await waitForJob(jobId, jobProcessor.STATUS.COMPLETED);

  assert.equal(job.speakerIdentification.applied, true);
  assert.equal(job.transcript.speakerIdentification.applied, true);
  assert.ok(job.transcript.segments.some(segment => segment.speakerLabel === "山田"));
  assert.match(job.minutes.markdown, /山田/);
});
