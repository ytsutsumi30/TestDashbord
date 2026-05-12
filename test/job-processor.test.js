const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

process.env.CLAUDE_MOCK = "true";
process.env.GRAPH_MOCK = "true";
process.env.SPEAKER_AUDIO_IDENTIFICATION_ENABLED = "false";

const jobProcessor = require("../services/job-processor");

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

test("startJobFromTeams completes and persists generated artifacts", async (t) => {
  const jobId = `unit-teams-${process.pid}-${Date.now()}`;
  t.after(() => cleanupJob(jobId));

  await jobProcessor.startJobFromTeams({
    jobId,
    mocked: true,
    meta: {
      title: "Unit Test Teams Meeting",
      room_id: "teams",
      device_id: "teams_webhook",
      started_at: "2026-05-12T09:00:00.000Z",
      ended_at: "2026-05-12T09:10:00.000Z",
      language: "ja-JP"
    },
    segments: [
      { start: 0, end: 4, speakerLabel: "会議室マイク", text: "田中：本日の会議を始めます。" },
      { start: 5, end: 9, speakerLabel: "会議室マイク", text: "鈴木：進捗は予定通りです。" }
    ]
  });

  const job = await waitForJob(jobId, jobProcessor.STATUS.COMPLETED);

  assert.equal(job.transcript.speakerCount, 2);
  assert.equal(job.speakerInference.applied, true);
  assert.deepEqual(job.transcript.segments.map(s => s.speakerLabel), ["田中", "鈴木"]);
  assert.equal(job.minutes.mocked, true);
  assert.ok(fs.existsSync(path.join(repoRoot, "storage", "jobs", `${jobId}.json`)));
  assert.ok(fs.existsSync(path.join(repoRoot, "storage", "transcripts", `${jobId}.json`)));
  assert.ok(fs.existsSync(path.join(repoRoot, "storage", "minutes", `${jobId}.docx`)));
  assert.ok(fs.existsSync(path.join(repoRoot, "storage", "minutes-md", `${jobId}.md`)));
});
