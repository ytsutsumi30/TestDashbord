#!/usr/bin/env node

const { loadEnv } = require("../services/env-loader");

const result = loadEnv();
const azureSpeech = require("../services/azure-speech");
const claude = require("../services/claude");
const graph = require("../services/graph");
const speakerRecognition = require("../services/speaker-recognition");
const queueConsumer = require("../services/queue-consumer");

const REQUIRED = {
  speech: ["AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION", "AZURE_SPEECH_ENDPOINT"],
  speaker: ["SPEAKER_RECOGNITION_ENDPOINT", "SPEAKER_RECOGNITION_KEY"],
  storage: ["AZURE_STORAGE_CONNECTION_STRING", "AZURE_BLOB_CONTAINER", "QUEUE_NAME"],
  graph: ["MS_TENANT_ID", "MS_CLIENT_ID", "MS_CLIENT_SECRET", "MS_USER_UPN"],
  claude: ["ANTHROPIC_API_KEY", "CLAUDE_MODEL"],
  webhook: ["WEBHOOK_CLIENT_STATE"]
};

async function main() {
  console.log("Meeting Minutes W8 preflight");
  console.log(`Loaded env files: ${result.loaded.length ? result.loaded.join(", ") : "(none)"}`);
  console.log("");

  let failed = false;
  for (const [group, keys] of Object.entries(REQUIRED)) {
    const missing = keys.filter(key => !String(process.env[key] || "").trim());
    if (missing.length) {
      failed = true;
      console.log(`[NG] ${group}: missing ${missing.join(", ")}`);
    } else {
      console.log(`[OK] ${group}: required values are set`);
    }
  }

  console.log("");
  console.log(`Speech mock: ${azureSpeech.isMock()}`);
  console.log(`Claude mock: ${claude.isMock()}`);
  console.log(`Graph mock: ${graph.isMock()}`);
  console.log(`Speaker recognition mock: ${speakerRecognition.isMock()}`);
  console.log(`Queue consumer mock: ${queueConsumer.isMock()}`);
  console.log(`API key auth: ${String(process.env.TESTDASHBOARD_API_KEY || "").trim() ? "enabled" : "disabled"}`);

  if (process.argv.includes("--graph-token")) {
    await verifyGraphToken();
  }

  if (failed) {
    console.log("");
    console.log("Preflight failed. Fill missing env values before W8 live verification.");
    process.exitCode = 1;
  }
}

async function verifyGraphToken() {
  console.log("");
  console.log("Checking Microsoft Graph client-credentials token...");
  if (graph.isMock()) {
    console.log("[SKIP] GRAPH_MOCK=true or Graph credentials missing.");
    return;
  }

  try {
    const token = await graph.getGraphToken();
    if (!token || token.length < 20) throw new Error("token response was empty");
    console.log("[OK] Graph token acquired. Admin consent / app credentials are usable for token issuance.");
  } catch (error) {
    console.log(`[NG] Graph token failed: ${error.message}`);
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
