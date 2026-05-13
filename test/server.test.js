const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");
const test = require("node:test");

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
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {
      // Retry until the server finishes binding.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("server did not become healthy");
}

async function jsonRequest(baseUrl, pathName, options = {}) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers
    }
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  return { response, body };
}

test("server exposes core dashboard APIs", async (t) => {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "speaker-profiles-"));
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
      SPEAKER_PROFILES_STORE_PATH: speakerProfilesStorePath
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stderr.resume();
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGTERM");
  });

  await waitForHealth(baseUrl, child);

  const headcount = await jsonRequest(baseUrl, "/ingest/headcount", {
    method: "POST",
    body: JSON.stringify({
      device_id: "AA:11:11:11:11:11",
      headcount: 3.8,
      confidence: "confirmed"
    })
  });
  assert.equal(headcount.response.status, 200);
  assert.equal(headcount.body.ok, true);
  assert.equal(headcount.body.room, "large");
  assert.equal(headcount.body.headcount, 3);

  const state = await jsonRequest(baseUrl, "/api/state");
  assert.equal(state.response.status, 200);
  assert.equal(state.body.rooms.find(room => room.id === "large").headcount, 3);

  const unknownDevice = await jsonRequest(baseUrl, "/ingest/headcount", {
    method: "POST",
    body: JSON.stringify({ device_id: "ZZ:ZZ:ZZ:ZZ:ZZ:ZZ", headcount: 1 })
  });
  assert.equal(unknownDevice.response.status, 202);
  assert.equal(unknownDevice.body.ok, false);

  const invalid = await jsonRequest(baseUrl, "/ingest/headcount", {
    method: "POST",
    body: JSON.stringify({ device_id: "AA:11:11:11:11:11" })
  });
  assert.equal(invalid.response.status, 400);

  const deviceMap = await jsonRequest(baseUrl, "/api/devices", {
    method: "POST",
    body: JSON.stringify({ device_id: "EE:55:55:55:55:55", room_id: "booth" })
  });
  assert.equal(deviceMap.response.status, 200);
  assert.equal(deviceMap.body.deviceMap["EE:55:55:55:55:55"], "booth");

  const reset = await jsonRequest(baseUrl, "/api/state", { method: "DELETE" });
  assert.equal(reset.response.status, 200);
  assert.equal(reset.body.ok, true);

  const jobs = await jsonRequest(baseUrl, "/api/jobs");
  assert.equal(jobs.response.status, 200);
  assert.equal(jobs.body.ok, true);
  assert.ok(Array.isArray(jobs.body.jobs));

  const missingJob = await jsonRequest(baseUrl, "/api/jobs?clientJobId=missing-android-job");
  assert.equal(missingJob.response.status, 200);
  assert.equal(missingJob.body.ok, true);
  assert.equal(missingJob.body.exists, false);

  const androidJobId = `android-server-test-${process.pid}-${Date.now()}`;
  t.after(() => cleanupJob(androidJobId));
  const recordingForm = new FormData();
  recordingForm.set("meta", JSON.stringify({
    job_id: androidJobId,
    device_id: "AA:11:11:11:11:11",
    room_id: "large",
    title: "Android照合APIテスト",
    started_at: "2026-05-14T09:00:00+09:00",
    ended_at: "2026-05-14T09:01:00+09:00",
    language: "ja-JP"
  }));
  recordingForm.set("audio", new Blob([Buffer.from("mock-m4a")], { type: "audio/mp4" }), `${androidJobId}.m4a`);

  const uploadResponse = await fetch(`${baseUrl}/ingest/recording`, {
    method: "POST",
    body: recordingForm
  });
  const uploadBody = await uploadResponse.json();
  assert.equal(uploadResponse.status, 202);
  assert.equal(uploadBody.job_id, androidJobId);
  assert.equal(uploadBody.server_job_id, androidJobId);

  const lookupJob = await jsonRequest(baseUrl, `/api/jobs?clientJobId=${encodeURIComponent(androidJobId)}`);
  assert.equal(lookupJob.response.status, 200);
  assert.equal(lookupJob.body.exists, true);
  assert.equal(lookupJob.body.job.jobId, androidJobId);
  assert.equal(lookupJob.body.job.clientJobId, androidJobId);

  const duplicateForm = new FormData();
  duplicateForm.set("meta", JSON.stringify({
    job_id: androidJobId,
    device_id: "AA:11:11:11:11:11",
    room_id: "large",
    title: "Android照合APIテスト",
    started_at: "2026-05-14T09:00:00+09:00",
    ended_at: "2026-05-14T09:01:00+09:00",
    language: "ja-JP"
  }));
  duplicateForm.set("audio", new Blob([Buffer.from("mock-m4a-duplicate")], { type: "audio/mp4" }), `${androidJobId}-retry.m4a`);
  const duplicateResponse = await fetch(`${baseUrl}/ingest/recording`, {
    method: "POST",
    body: duplicateForm
  });
  const duplicateBody = await duplicateResponse.json();
  assert.equal(duplicateResponse.status, 200);
  assert.equal(duplicateBody.duplicate, true);
  assert.equal(duplicateBody.server_job_id, androidJobId);

  const profiles = await jsonRequest(baseUrl, "/api/speaker-profiles");
  assert.equal(profiles.response.status, 200);
  assert.deepEqual(profiles.body.profiles, []);

  const form = new FormData();
  form.set("displayName", "谷崎");
  form.set("email", "tanizaki@example.com");
  form.set("department", "PSUユニット");
  form.set("locale", "ja-JP");
  form.set("audio", new Blob([Buffer.from("RIFFmockwav")], { type: "audio/wav" }), "tanizaki.wav");
  const createResponse = await fetch(`${baseUrl}/api/speaker-profiles`, {
    method: "POST",
    body: form
  });
  const createBody = await createResponse.json();
  assert.equal(createResponse.status, 201);
  assert.equal(createBody.ok, true);
  assert.equal(createBody.profile.displayName, "谷崎");
  assert.equal(createBody.profile.enrollmentStatus, "Enrolled");
  assert.equal(createBody.profile.mocked, true);

  const createdId = createBody.profile.id;
  const enrollForm = new FormData();
  enrollForm.set("audio", new Blob([Buffer.from("RIFFmockwav2")], { type: "audio/wav" }), "tanizaki-2.wav");
  const enrollResponse = await fetch(`${baseUrl}/api/speaker-profiles/${createdId}/enroll`, {
    method: "POST",
    body: enrollForm
  });
  const enrollBody = await enrollResponse.json();
  assert.equal(enrollResponse.status, 200);
  assert.equal(enrollBody.profile.enrollmentStatus, "Enrolled");

  const refresh = await jsonRequest(baseUrl, `/api/speaker-profiles/${createdId}/refresh`, { method: "POST" });
  assert.equal(refresh.response.status, 200);
  assert.equal(refresh.body.profile.enrollmentStatus, "Enrolled");

  const profilesAfterCreate = await jsonRequest(baseUrl, "/api/speaker-profiles");
  assert.equal(profilesAfterCreate.body.profiles.length, 1);
  assert.equal(profilesAfterCreate.body.profiles[0].displayName, "谷崎");

  const deleteProfile = await jsonRequest(baseUrl, `/api/speaker-profiles/${createdId}`, { method: "DELETE" });
  assert.equal(deleteProfile.response.status, 200);
  assert.equal(deleteProfile.body.ok, true);
});
