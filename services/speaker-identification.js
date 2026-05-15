// ============================================================
// Real audio speaker identification pipeline
// ============================================================
// Teams recording -> Azure Speech diarization -> audio segment extraction
// -> Azure Speaker Recognition -> transcript speaker labels.
// ============================================================

const fs = require("fs");
const path = require("path");
const audioPublisher = require("./audio-publisher");
const azureSpeech = require("./azure-speech");
const graph = require("./graph");
const audioSegments = require("./audio-segments");
const speakerProfiles = require("./speaker-profiles");
const speakerRecognition = require("./speaker-recognition");

const RECORDINGS_DIR = path.join(__dirname, "..", "storage", "teams-recordings");
const SEGMENTS_DIR = path.join(__dirname, "..", "storage", "speaker-segments");
const UNKNOWN = "話者未識別";

function isEnabled() {
  return (process.env.SPEAKER_AUDIO_IDENTIFICATION_ENABLED || "true").toLowerCase() === "true";
}

async function identifyTeamsTranscriptSpeakers({ jobId, meta, segments }) {
  if (!isEnabled()) {
    return skipped(segments, "disabled");
  }

  const profiles = enrolledProfiles();
  if (profiles.length < 1) {
    return skipped(segments, "no_enrolled_profiles");
  }
  if (!meta?.meetingId) {
    return skipped(segments, "missing_meeting_id");
  }

  let downloaded = null;
  let published = null;
  try {
    downloaded = await graph.downloadTeamsRecording({
      meetingId: meta.meetingId,
      transcriptId: meta.transcriptId,
      recordingId: meta.recordingId,
      outputDir: RECORDINGS_DIR,
      filename: `${jobId}.mp4`
    });
    if (!downloaded?.filePath) return skipped(segments, "recording_not_found");

    published = await audioPublisher.publish(downloaded.filePath);
    const diarized = await azureSpeech.transcribeAudio({
      audioUrl: published.url,
      displayName: `teams-recording-${jobId}`,
      locale: meta.language || "ja-JP"
    });

    const identified = await identifyDiarizedSpeakers({
      jobId,
      recordingFile: downloaded.filePath,
      diarizedSegments: diarized.segments,
      profiles
    });
    const applied = applyIdentifiedLabels({
      transcriptSegments: segments,
      diarizedSegments: diarized.segments,
      speakerMap: identified.speakerMap
    });
    const summary = buildSummary({
      downloaded,
      diarized,
      identified,
      profiles,
      segments: applied
    });
    return { segments: applied, summary };
  } catch (error) {
    return {
      segments,
      summary: {
        applied: false,
        source: "audio_speaker_identification",
        reason: "failed",
        error: error.message,
        note: "Audio speaker identification failed; text-based fallback may still run."
      }
    };
  } finally {
    if (published?.token) audioPublisher.revoke(published.token);
    cleanupDownloadedRecording(downloaded);
  }
}

async function identifyRoomTranscriptSpeakers({ jobId, audioFile, segments }) {
  if (!isEnabled()) {
    return skipped(segments, "disabled");
  }

  const profiles = enrolledProfiles();
  if (profiles.length < 1) {
    return skipped(segments, "no_enrolled_profiles");
  }
  if (!audioFile) {
    return skipped(segments, "missing_audio_file");
  }

  try {
    const identified = await identifyDiarizedSpeakers({
      jobId,
      recordingFile: audioFile,
      diarizedSegments: segments,
      profiles
    });
    const applied = applyIdentifiedLabels({
      transcriptSegments: segments,
      diarizedSegments: segments,
      speakerMap: identified.speakerMap
    });
    const summary = buildSummary({
      downloaded: { recording: null, mocked: false },
      diarized: {
        jobUrl: null,
        speakerCount: new Set((segments || []).map(s => s.speakerId ?? s.speakerLabel).filter(Boolean)).size
      },
      identified,
      profiles,
      segments: applied,
      note: "Audio-based speaker identification was applied to the Android/room recording transcript."
    });
    if (!summary.applied) {
      return { segments, summary };
    }
    return { segments: applied, summary };
  } catch (error) {
    return {
      segments,
      summary: {
        applied: false,
        source: "audio_speaker_identification",
        reason: "failed",
        error: error.message,
        note: "Room recording speaker identification failed; original diarization labels were preserved."
      }
    };
  }
}

async function identifyDiarizedSpeakers({ jobId, recordingFile, diarizedSegments, profiles }) {
  const minDurationSec = Number(process.env.SPEAKER_IDENTIFICATION_MIN_SEGMENT_SEC || 4);
  const threshold = Number(process.env.SPEAKER_IDENTIFICATION_MIN_SCORE || 0.65);
  const ignoreMinLength = (process.env.SPEAKER_IDENTIFICATION_IGNORE_MIN_LENGTH || "").toLowerCase() === "true";
  const samples = await audioSegments.extractRepresentativeSegments({
    sourceFile: recordingFile,
    outputDir: SEGMENTS_DIR,
    jobId,
    segments: diarizedSegments,
    minDurationSec,
    maxDurationSec: 120,
    allowShort: ignoreMinLength || speakerRecognition.isMock()
  });

  const profileByAzureId = new Map(profiles.map(profile => [profile.azureProfileId, profile]));
  const profileIds = profiles.map(profile => profile.azureProfileId);
  const speakerMap = {};
  const identifications = [];

  for (const sample of samples) {
    const result = await speakerRecognition.identifySingleSpeaker({
      audioFile: sample.audioFile,
      profileIds,
      ignoreMinLength
    });
    const best = result.identifiedProfile || result.profilesRanking?.[0] || null;
    const profile = best ? profileByAzureId.get(best.profileId) : null;
    const score = Number(best?.score || 0);
    const accepted = !!profile && score >= threshold;
    speakerMap[sample.speakerKey] = accepted
      ? { label: profile.displayName, profileId: profile.id, azureProfileId: profile.azureProfileId, score }
      : { label: UNKNOWN, score, rejected: true };
    identifications.push({
      speakerKey: sample.speakerKey,
      speakerLabel: sample.speakerLabel,
      profileId: profile?.id || null,
      azureProfileId: best?.profileId || null,
      displayName: accepted ? profile.displayName : UNKNOWN,
      score,
      accepted,
      mocked: !!result.mocked
    });
  }

  cleanupSamples(samples);
  return { speakerMap, identifications, threshold, sampleCount: samples.length };
}

function applyIdentifiedLabels({ transcriptSegments, diarizedSegments, speakerMap }) {
  return (transcriptSegments || []).map(segment => {
    const diarized = bestOverlapSegment(segment, diarizedSegments);
    const key = diarized ? String(diarized.speakerId ?? diarized.speakerLabel) : null;
    const match = key ? speakerMap[key] : null;
    if (!match) {
      return {
        ...segment,
        speakerOriginalLabel: segment.speakerLabel,
        speakerLabel: UNKNOWN,
        speakerIdentification: { source: "audio_speaker_identification", status: "unmatched" }
      };
    }
    return {
      ...segment,
      speakerOriginalLabel: segment.speakerLabel,
      speakerLabel: match.label,
      speakerIdentification: {
        source: "audio_speaker_identification",
        status: match.rejected ? "low_confidence" : "identified",
        score: match.score,
        profileId: match.profileId || null,
        azureProfileId: match.azureProfileId || null,
        diarizedSpeakerKey: key
      }
    };
  });
}

function bestOverlapSegment(target, candidates) {
  let best = null;
  let bestOverlap = 0;
  for (const candidate of candidates || []) {
    const overlap = Math.max(0, Math.min(Number(target.end || 0), Number(candidate.end || 0)) - Math.max(Number(target.start || 0), Number(candidate.start || 0)));
    if (overlap > bestOverlap) {
      best = candidate;
      bestOverlap = overlap;
    }
  }
  return best;
}

function buildSummary({ downloaded, diarized, identified, profiles, segments, note = null }) {
  const identifiedCount = segments.filter(segment => segment.speakerIdentification?.status === "identified").length;
  const unknownCount = segments.filter(segment => segment.speakerLabel === UNKNOWN).length;
  return {
    applied: identifiedCount > 0,
    source: "audio_speaker_identification",
    reason: identifiedCount > 0 ? "recording_diarization_profile_match" : "no_confident_match",
    recordingId: downloaded.recording?.id || null,
    recordingMocked: !!downloaded.mocked,
    diarizationJobUrl: diarized.jobUrl || null,
    diarizedSpeakerCount: diarized.speakerCount,
    candidateProfileCount: profiles.length,
    sampleCount: identified.sampleCount,
    threshold: identified.threshold,
    identifications: identified.identifications,
    identifiedCount,
    unknownCount,
    note: note || "Audio-based speaker identification applies only matches above threshold; low-confidence segments remain unidentified."
  };
}

function skipped(segments, reason) {
  return {
    segments,
    summary: {
      applied: false,
      source: "audio_speaker_identification",
      reason,
      note: "Audio speaker identification was skipped."
    }
  };
}

function enrolledProfiles() {
  return speakerProfiles.listProfiles().filter(profile =>
    profile.azureProfileId &&
    String(profile.enrollmentStatus || "").toLowerCase() === "enrolled"
  );
}

function cleanupSamples(samples) {
  for (const sample of samples || []) {
    if (sample.audioFile) fs.promises.unlink(sample.audioFile).catch(() => {});
  }
}

function cleanupDownloadedRecording(downloaded) {
  if ((process.env.SPEAKER_KEEP_TEAM_RECORDINGS || "").toLowerCase() === "true") return;
  if (downloaded?.filePath) fs.promises.unlink(downloaded.filePath).catch(() => {});
}

module.exports = {
  UNKNOWN,
  isEnabled,
  identifyTeamsTranscriptSpeakers,
  identifyRoomTranscriptSpeakers,
  identifyDiarizedSpeakers,
  applyIdentifiedLabels,
  bestOverlapSegment
};
