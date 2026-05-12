// ============================================================
// Azure Speaker Recognition client
// ============================================================
// Text Independent Identification profile lifecycle wrapper.
//
// Env:
//   SPEAKER_RECOGNITION_MOCK=true  ... do not call Azure
//   SPEAKER_RECOGNITION_ENDPOINT   ... https://<region>.api.cognitive.microsoft.com
//   SPEAKER_RECOGNITION_KEY        ... Azure AI Services key
//   AZURE_SPEECH_REGION            ... fallback endpoint region
//   AZURE_SPEECH_KEY               ... fallback key
// ============================================================

const fs = require("fs");

const API_VERSION = "2021-09-05";
const REGION = process.env.AZURE_SPEECH_REGION || "japaneast";
const ENDPOINT = (process.env.SPEAKER_RECOGNITION_ENDPOINT || `https://${REGION}.api.cognitive.microsoft.com`).replace(/\/+$/, "");
const KEY = process.env.SPEAKER_RECOGNITION_KEY || process.env.AZURE_SPEECH_KEY || "";
const MOCK_MODE = (process.env.SPEAKER_RECOGNITION_MOCK || "").toLowerCase() === "true";

function isMock() {
  return MOCK_MODE || !KEY;
}

async function createIdentificationProfile({ locale = "ja-JP" } = {}) {
  if (isMock()) {
    return {
      profileId: `mock-profile-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      locale,
      profileStatus: "Active",
      enrollmentStatus: "Enrolling",
      enrollmentsCount: 0,
      remainingEnrollmentsSpeechLengthInSec: 20,
      mocked: true
    };
  }

  const response = await fetch(`${ENDPOINT}/speaker-recognition/identification/text-independent/profiles?api-version=${API_VERSION}`, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ locale })
  });
  return await parseResponse(response, "create speaker profile");
}

async function enrollIdentificationProfile({ profileId, audioFile, ignoreMinLength = false }) {
  if (!profileId) throw new Error("profileId is required");
  if (!audioFile) throw new Error("audioFile is required");

  if (isMock()) {
    const stat = fs.existsSync(audioFile) ? fs.statSync(audioFile) : { size: 0 };
    return {
      profileId,
      enrollmentStatus: "Enrolled",
      enrollmentsCount: 1,
      audioLengthInSec: Math.max(1, Math.round(stat.size / 32_000)),
      audioSpeechLengthInSec: Math.max(1, Math.round(stat.size / 32_000)),
      remainingEnrollmentsSpeechLengthInSec: 0,
      mocked: true
    };
  }

  const query = new URLSearchParams({ "api-version": API_VERSION });
  if (ignoreMinLength) query.set("ignoreMinLength", "true");
  const response = await fetch(
    `${ENDPOINT}/speaker-recognition/identification/text-independent/profiles/${encodeURIComponent(profileId)}/enrollments?${query}`,
    {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": KEY,
        "Content-Type": "audio/wav; codecs=audio/pcm"
      },
      body: fs.readFileSync(audioFile)
    }
  );
  return await parseResponse(response, "enroll speaker profile");
}

async function getIdentificationProfile(profileId) {
  if (!profileId) throw new Error("profileId is required");

  if (isMock()) {
    return {
      profileId,
      profileStatus: "Active",
      enrollmentStatus: "Enrolled",
      enrollmentsCount: 1,
      enrollmentsSpeechLengthInSec: 20,
      remainingEnrollmentsSpeechLengthInSec: 0,
      mocked: true
    };
  }

  const response = await fetch(
    `${ENDPOINT}/speaker-recognition/identification/text-independent/profiles/${encodeURIComponent(profileId)}?api-version=${API_VERSION}`,
    { headers: { "Ocp-Apim-Subscription-Key": KEY } }
  );
  return await parseResponse(response, "get speaker profile");
}

async function deleteIdentificationProfile(profileId) {
  if (!profileId) throw new Error("profileId is required");

  if (isMock()) return { ok: true, mocked: true };

  const response = await fetch(
    `${ENDPOINT}/speaker-recognition/identification/text-independent/profiles/${encodeURIComponent(profileId)}?api-version=${API_VERSION}`,
    {
      method: "DELETE",
      headers: { "Ocp-Apim-Subscription-Key": KEY }
    }
  );
  if (response.status === 204) return { ok: true };
  return await parseResponse(response, "delete speaker profile");
}

async function parseResponse(response, operation) {
  const text = await response.text();
  const body = text ? safeJson(text) : {};
  if (!response.ok) {
    throw new Error(`${operation} failed: HTTP ${response.status} ${text}`);
  }
  return body;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

module.exports = {
  isMock,
  createIdentificationProfile,
  enrollIdentificationProfile,
  getIdentificationProfile,
  deleteIdentificationProfile
};
