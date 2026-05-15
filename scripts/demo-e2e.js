#!/usr/bin/env node

const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const DEMO_API_KEY = "demo-e2e-local-key";

async function main() {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const jobId = `demo-e2e-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-e2e-"));
  const speakerProfilesStorePath = path.join(tempDir, "speaker-profiles.json");
  const artifactDir = path.join(repoRoot, "storage", "demo-e2e", jobId);
  fs.mkdirSync(artifactDir, { recursive: true });

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
      SPEAKER_SEGMENT_MOCK: "true",
      SPEAKER_AUDIO_IDENTIFICATION_ENABLED: "true",
      SPEAKER_IDENTIFICATION_IGNORE_MIN_LENGTH: "true",
      PUBLISH_MODE: "local",
      PUBLIC_BASE_URL: baseUrl,
      AZURE_STORAGE_CONNECTION_STRING: "",
      SPEAKER_PROFILES_STORE_PATH: speakerProfilesStorePath,
      TESTDASHBOARD_API_KEY: DEMO_API_KEY
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

    const profile = await createSpeakerProfile(baseUrl);
    assert(profile.displayName === "デモ山田", "speaker profile was not created");

    const uploadBody = await uploadRecording(baseUrl, jobId);
    assert(uploadBody.server_job_id === jobId, "server_job_id mismatch");

    const completed = await waitForJob(baseUrl, jobId);
    assert(completed.status === "completed", "job did not complete");
    assert(completed.speakerIdentification?.applied, "speaker profile identification was not applied");
    assert(completed.transcript?.segments?.some(segment => segment.speakerLabel === "デモ山田"), "speaker label was not replaced by profile name");
    assert(completed.minutes?.markdownUrl, "markdown URL missing");
    assert(completed.minutes?.downloadUrl, "docx URL missing");

    const markdownText = await fetchText(`${baseUrl}${completed.minutes.markdownUrl}`);
    assert(markdownText.includes("文字起こし全文"), "markdown transcript appendix missing");
    assert(markdownText.includes("デモ山田"), "markdown does not include identified speaker");
    fs.writeFileSync(path.join(artifactDir, `${jobId}.md`), markdownText, "utf8");

    const docx = await fetchBuffer(`${baseUrl}${completed.minutes.downloadUrl}`);
    assert(docx.length > 1000, "docx artifact is too small");
    fs.writeFileSync(path.join(artifactDir, `${jobId}.docx`), docx);

    const summary = {
      ok: true,
      jobId,
      baseUrl,
      artifactDir,
      speakerProfile: {
        id: profile.id,
        displayName: profile.displayName,
        enrollmentStatus: profile.enrollmentStatus
      },
      speakerIdentification: completed.speakerIdentification,
      markdown: path.join(artifactDir, `${jobId}.md`),
      docx: path.join(artifactDir, `${jobId}.docx`)
    };
    fs.writeFileSync(path.join(artifactDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");

    console.log("");
    console.log("Demo E2E passed.");
    console.log(`Job: ${jobId}`);
    console.log(`Artifacts: ${artifactDir}`);
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function createSpeakerProfile(baseUrl) {
  const form = new FormData();
  form.set("displayName", "デモ山田");
  form.set("email", "demo-yamada@example.com");
  form.set("department", "デモ部");
  form.set("locale", "ja-JP");
  form.set("ignoreMinLength", "true");
  form.set("audio", new Blob([Buffer.from("RIFF demo speaker wav")], { type: "audio/wav" }), "demo-yamada.wav");

  const response = await apiFetch(`${baseUrl}/api/speaker-profiles`, { method: "POST", body: form });
  const body = await response.json();
  assert(response.status === 201, `speaker profile failed HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body.profile;
}

async function uploadRecording(baseUrl, jobId) {
  const form = new FormData();
  form.set("meta", JSON.stringify({
    job_id: jobId,
    device_id: "AA:11:11:11:11:11",
    room_id: "large",
    title: "デモE2E 会議",
    started_at: "2026-05-15T10:00:00+09:00",
    ended_at: "2026-05-15T10:10:00+09:00",
    attendees_estimated: 4,
    language: "ja-JP"
  }));
  form.set("audio", new Blob([Buffer.from("mock demo meeting m4a")], { type: "audio/mp4" }), `${jobId}.m4a`);

  const response = await apiFetch(`${baseUrl}/ingest/recording`, { method: "POST", body: form });
  const body = await response.json();
  assert(response.status === 202, `recording upload failed HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("X-API-Key", DEMO_API_KEY);
  return fetch(url, { ...options, headers });
}

async function postJson(url, body) {
  const response = await apiFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = await response.json();
  if (!response.ok) throw new Error(`${url} failed HTTP ${response.status}: ${JSON.stringify(json)}`);
  return json;
}

async function getJson(url) {
  const response = await apiFetch(url);
  const json = await response.json();
  if (!response.ok) throw new Error(`${url} failed HTTP ${response.status}: ${JSON.stringify(json)}`);
  return json;
}

async function fetchText(url) {
  const response = await apiFetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`${url} failed HTTP ${response.status}: ${text.slice(0, 200)}`);
  return text;
}

async function fetchBuffer(url) {
  const response = await apiFetch(url);
  const arrayBuffer = await response.arrayBuffer();
  if (!response.ok) throw new Error(`${url} failed HTTP ${response.status}`);
  return Buffer.from(arrayBuffer);
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

async function waitForJob(baseUrl, jobId, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = await getJson(`${baseUrl}/api/jobs/${encodeURIComponent(jobId)}`);
    if (body.status === "completed") return body;
    if (body.status === "failed") throw new Error(`job failed: ${body.error}`);
    await sleep(200);
  }
  throw new Error(`timed out waiting for job ${jobId}`);
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function prefixLines(prefix, chunk) {
  return String(chunk).split(/\r?\n/).filter(Boolean).map(line => `${prefix}${line}\n`).join("");
}

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
