#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { spawn } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");

async function main() {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const jobId = `w8-smoke-${Date.now()}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "w8-smoke-"));
  const speakerProfilesStorePath = path.join(tempDir, "speaker-profiles.json");

  const child = spawn(process.execPath, ["server.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      AZURE_SPEECH_MOCK: "true",
      CLAUDE_MOCK: "true",
      GRAPH_MOCK: "true",
      QUEUE_CONSUMER_MOCK: "true",
      SPEAKER_RECOGNITION_MOCK: "true",
      SPEAKER_AUDIO_IDENTIFICATION_ENABLED: "false",
      PUBLISH_MODE: "local",
      PUBLIC_BASE_URL: baseUrl,
      AZURE_STORAGE_CONNECTION_STRING: "",
      SPEAKER_PROFILES_STORE_PATH: speakerProfilesStorePath
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.on("data", chunk => process.stdout.write(prefixLines("[server] ", chunk)));
  child.stderr.on("data", chunk => process.stderr.write(prefixLines("[server] ", chunk)));

  try {
    await waitForHealth(baseUrl, child);
    await postJson(`${baseUrl}/ingest/headcount`, {
      device_id: "AA:11:11:11:11:11",
      headcount: 4,
      confidence: "confirmed"
    });

    const state = await getJson(`${baseUrl}/api/state`);
    assert(state.rooms.find(room => room.id === "large").headcount === 4, "headcount did not update");

    const form = new FormData();
    form.set("meta", JSON.stringify({
      job_id: jobId,
      device_id: "AA:11:11:11:11:11",
      room_id: "large",
      title: "W8 smoke local",
      started_at: "2026-05-14T09:00:00+09:00",
      ended_at: "2026-05-14T09:01:00+09:00",
      language: "ja-JP"
    }));
    form.set("audio", new Blob([Buffer.from("mock-audio")], { type: "audio/mp4" }), `${jobId}.m4a`);
    const upload = await fetch(`${baseUrl}/ingest/recording`, { method: "POST", body: form });
    const uploadBody = await upload.json();
    assert(upload.status === 202, `upload failed HTTP ${upload.status}`);
    assert(uploadBody.server_job_id === jobId, "server_job_id mismatch");

    const completed = await waitForJob(baseUrl, jobId);
    assert(completed.status === "completed", "job did not complete");
    assert(completed.transcript?.segments?.length > 0, "transcript missing");
    assert(completed.minutes?.markdownUrl, "markdown URL missing");
    assert(completed.minutes?.downloadUrl, "download URL missing");

    const lookup = await getJson(`${baseUrl}/api/jobs?clientJobId=${encodeURIComponent(jobId)}`);
    assert(lookup.exists === true, "clientJobId lookup did not find job");
    assert(lookup.job.jobId === jobId, "lookup jobId mismatch");

    const markdown = await fetch(`${baseUrl}${completed.minutes.markdownUrl}`);
    const markdownText = await markdown.text();
    assert(markdown.ok, "markdown download failed");
    assert(markdownText.includes("文字起こし全文"), "markdown transcript appendix missing");

    console.log("");
    console.log("W8 local smoke passed.");
    console.log(`Job: ${jobId}`);
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    cleanupJob(jobId);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, child, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited: ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {
      // retry
    }
    await sleep(100);
  }
  throw new Error("server did not become healthy");
}

async function waitForJob(baseUrl, jobId, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = await getJson(`${baseUrl}/api/jobs/${encodeURIComponent(jobId)}`);
    if (body.status === "completed") return body;
    if (body.status === "failed") throw new Error(`job failed: ${body.error}`);
    await sleep(200);
  }
  throw new Error(`timed out waiting for job ${jobId}`);
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = await response.json();
  if (!response.ok) throw new Error(`${url} failed HTTP ${response.status}: ${JSON.stringify(json)}`);
  return json;
}

async function getJson(url) {
  const response = await fetch(url);
  const json = await response.json();
  if (!response.ok) throw new Error(`${url} failed HTTP ${response.status}: ${JSON.stringify(json)}`);
  return json;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function prefixLines(prefix, chunk) {
  return String(chunk).split(/\r?\n/).filter(Boolean).map(line => `${prefix}${line}\n`).join("");
}

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

main().catch(error => {
  console.error(error);
  process.exit(1);
});
