const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "speaker-identification-"));
process.env.SPEAKER_PROFILES_STORE_PATH = path.join(tempDir, "speaker-profiles.json");
process.env.SPEAKER_RECOGNITION_MOCK = "true";
process.env.SPEAKER_SEGMENT_MOCK = "true";
process.env.AZURE_SPEECH_MOCK = "true";
process.env.GRAPH_MOCK = "true";
process.env.SPEAKER_AUDIO_IDENTIFICATION_ENABLED = "true";

const speakerProfiles = require("../services/speaker-profiles");
const speakerIdentification = require("../services/speaker-identification");
const audioSegments = require("../services/audio-segments");

test("selectRepresentativeSegments picks longest segment per diarized speaker", () => {
  const selected = audioSegments.selectRepresentativeSegments([
    { start: 0, end: 2, speakerId: 1, speakerLabel: "Speaker 1" },
    { start: 3, end: 9, speakerId: 1, speakerLabel: "Speaker 1" },
    { start: 10, end: 15, speakerId: 2, speakerLabel: "Speaker 2" }
  ]);

  assert.equal(selected.length, 2);
  assert.equal(selected.find(s => s.speakerKey === "1").duration, 6);
  assert.equal(selected.find(s => s.speakerKey === "2").duration, 5);
});

test("identifyTeamsTranscriptSpeakers applies enrolled profile labels from recording audio", async () => {
  const wavPath = path.join(tempDir, "profile.wav");
  fs.writeFileSync(wavPath, Buffer.from("RIFF profile wav"));
  await speakerProfiles.createProfile({
    displayName: "谷崎",
    email: "tanizaki@example.com",
    department: "PSU",
    audioFile: wavPath
  });

  const result = await speakerIdentification.identifyTeamsTranscriptSpeakers({
    jobId: `speaker-ident-${process.pid}-${Date.now()}`,
    meta: {
      meetingId: "meeting-001",
      transcriptId: "transcript-001",
      recordingId: "recording-001",
      language: "ja-JP"
    },
    segments: [
      { start: 0, end: 4, speakerLabel: "会議室マイク", text: "開始します。" },
      { start: 5, end: 9, speakerLabel: "会議室マイク", text: "承知しました。" }
    ]
  });

  assert.equal(result.summary.applied, true);
  assert.equal(result.summary.source, "audio_speaker_identification");
  assert.ok(result.summary.identifiedCount >= 1);
  assert.ok(result.segments.every(segment => segment.speakerIdentification));
  assert.ok(result.segments.some(segment => segment.speakerLabel === "谷崎"));
});
