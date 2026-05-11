const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");

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
  const child = spawn(process.execPath, ["server.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      AZURE_SPEECH_MOCK: "true",
      CLAUDE_MOCK: "true",
      GRAPH_MOCK: "true",
      QUEUE_CONSUMER_MOCK: "true"
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

});
