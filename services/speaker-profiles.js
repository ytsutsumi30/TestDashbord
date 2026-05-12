// ============================================================
// Speaker profile registry
// ============================================================
// Stores local participant metadata and links it to Azure Speaker
// Recognition identification profiles. Audio files are used only for
// enrollment and are deleted by the route after processing.
// ============================================================

const fs = require("fs");
const path = require("path");
const speakerRecognition = require("./speaker-recognition");

const STORE_PATH = process.env.SPEAKER_PROFILES_STORE_PATH ||
  path.join(__dirname, "..", "storage", "speaker-profiles.json");

function listProfiles() {
  return readStore().profiles.sort((a, b) => String(a.displayName).localeCompare(String(b.displayName), "ja"));
}

function getProfile(id) {
  return readStore().profiles.find(profile => profile.id === id) || null;
}

async function createProfile({ displayName, email = "", department = "", locale = "ja-JP", audioFile = null, ignoreMinLength = false }) {
  const name = String(displayName || "").trim();
  if (!name) throw statusError(400, "displayName is required");

  const now = new Date().toISOString();
  const azureProfile = await speakerRecognition.createIdentificationProfile({ locale });
  let profile = {
    id: newLocalId(),
    displayName: name,
    email: String(email || "").trim(),
    department: String(department || "").trim(),
    locale,
    azureProfileId: azureProfile.profileId,
    profileStatus: azureProfile.profileStatus || "Active",
    enrollmentStatus: azureProfile.enrollmentStatus || "Enrolling",
    enrollmentsCount: azureProfile.enrollmentsCount || 0,
    enrollmentsSpeechLengthInSec: azureProfile.enrollmentsSpeechLengthInSec || 0,
    remainingEnrollmentsSpeechLengthInSec: azureProfile.remainingEnrollmentsSpeechLengthInSec ?? null,
    mocked: !!azureProfile.mocked || speakerRecognition.isMock(),
    createdAt: now,
    updatedAt: now,
    lastEnrollmentAt: null,
    error: null
  };

  if (audioFile) {
    profile = mergeEnrollment(profile, await speakerRecognition.enrollIdentificationProfile({
      profileId: profile.azureProfileId,
      audioFile,
      ignoreMinLength
    }));
  }

  const store = readStore();
  store.profiles.push(profile);
  writeStore(store);
  return profile;
}

async function enrollProfile(id, { audioFile, ignoreMinLength = false }) {
  if (!audioFile) throw statusError(400, "audio file is required");
  const store = readStore();
  const index = store.profiles.findIndex(profile => profile.id === id);
  if (index < 0) throw statusError(404, "speaker profile not found");

  const profile = store.profiles[index];
  try {
    store.profiles[index] = mergeEnrollment(profile, await speakerRecognition.enrollIdentificationProfile({
      profileId: profile.azureProfileId,
      audioFile,
      ignoreMinLength
    }));
  } catch (error) {
    store.profiles[index] = {
      ...profile,
      error: error.message,
      updatedAt: new Date().toISOString()
    };
    writeStore(store);
    throw error;
  }

  writeStore(store);
  return store.profiles[index];
}

async function refreshProfile(id) {
  const store = readStore();
  const index = store.profiles.findIndex(profile => profile.id === id);
  if (index < 0) throw statusError(404, "speaker profile not found");

  const profile = store.profiles[index];
  const remote = await speakerRecognition.getIdentificationProfile(profile.azureProfileId);
  store.profiles[index] = mergeRemoteStatus(profile, remote);
  writeStore(store);
  return store.profiles[index];
}

async function deleteProfile(id) {
  const store = readStore();
  const index = store.profiles.findIndex(profile => profile.id === id);
  if (index < 0) throw statusError(404, "speaker profile not found");
  const [profile] = store.profiles.splice(index, 1);
  await speakerRecognition.deleteIdentificationProfile(profile.azureProfileId);
  writeStore(store);
  return { ok: true, deleted: id };
}

function mergeEnrollment(profile, enrollment) {
  const now = new Date().toISOString();
  return mergeRemoteStatus({
    ...profile,
    lastEnrollmentAt: now,
    error: null
  }, enrollment, now);
}

function mergeRemoteStatus(profile, remote, now = new Date().toISOString()) {
  return {
    ...profile,
    profileStatus: remote.profileStatus || profile.profileStatus,
    enrollmentStatus: remote.enrollmentStatus || profile.enrollmentStatus,
    enrollmentsCount: remote.enrollmentsCount ?? profile.enrollmentsCount,
    enrollmentsSpeechLengthInSec: remote.enrollmentsSpeechLengthInSec ?? remote.audioSpeechLengthInSec ?? profile.enrollmentsSpeechLengthInSec,
    remainingEnrollmentsSpeechLengthInSec: remote.remainingEnrollmentsSpeechLengthInSec ?? profile.remainingEnrollmentsSpeechLengthInSec,
    mocked: !!remote.mocked || profile.mocked,
    updatedAt: now,
    error: null
  };
}

function readStore() {
  ensureStoreDir();
  if (!fs.existsSync(STORE_PATH)) return { profiles: [] };
  const data = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
  return { profiles: Array.isArray(data.profiles) ? data.profiles : [] };
}

function writeStore(store) {
  ensureStoreDir();
  const tmp = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ profiles: store.profiles || [] }, null, 2));
  fs.renameSync(tmp, STORE_PATH);
}

function ensureStoreDir() {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
}

function newLocalId() {
  return `spk-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function statusError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

module.exports = {
  listProfiles,
  getProfile,
  createProfile,
  enrollProfile,
  refreshProfile,
  deleteProfile
};
