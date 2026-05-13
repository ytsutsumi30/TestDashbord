// ============================================================
// Transcript Merger
// ============================================================
// Teams transcript と会議室/Android録音 transcript を時系列で統合する。
// 重複発話は時間重なり + テキスト類似度で1行にまとめ、話者名は
// より具体的なラベルを優先する。
// ============================================================

const GENERIC_LABELS = [
  /^unknown$/i,
  /^speaker\s*\d+$/i,
  /^話者\s*\d+$/i,
  /^話者未識別$/,
  /^会議室マイク$/,
  /^teams$/i,
  /^microsoft teams$/i
];

function mergeTranscripts({
  primarySegments = [],
  secondarySegments = [],
  primaryMeta = {},
  secondaryMeta = {},
  primarySource = "teams",
  secondarySource = "room"
} = {}) {
  const primary = normalizeSegments(primarySegments, primarySource, 0);
  const offset = getStartOffsetSeconds(primaryMeta?.started_at, secondaryMeta?.started_at);
  const secondary = normalizeSegments(secondarySegments, secondarySource, offset);

  const merged = primary.map(segment => ({ ...segment }));
  let mergedCount = 0;
  let appendedCount = 0;

  for (const candidate of secondary) {
    const match = findDuplicate(merged, candidate);
    if (match) {
      const index = merged.indexOf(match);
      merged[index] = mergePair(match, candidate);
      mergedCount++;
    } else {
      merged.push(candidate);
      appendedCount++;
    }
  }

  merged.sort((a, b) => (a.start || 0) - (b.start || 0) || (a.end || 0) - (b.end || 0));
  const segments = merged.map((segment, index) => ({
    ...segment,
    index,
    duration: Math.max(0, (segment.end || segment.start || 0) - (segment.start || 0))
  }));

  return {
    segments,
    summary: {
      applied: secondary.length > 0,
      source: "transcript_merger",
      primarySource,
      secondarySource,
      primaryCount: primary.length,
      secondaryCount: secondary.length,
      mergedCount,
      appendedCount,
      outputCount: segments.length,
      offsetSeconds: offset
    }
  };
}

function normalizeSegments(segments, source, offsetSeconds) {
  return (segments || [])
    .filter(segment => segment && String(segment.text || "").trim())
    .map((segment, index) => {
      const start = Number(segment.start ?? 0) + offsetSeconds;
      const end = Number(segment.end ?? (segment.start ?? 0)) + offsetSeconds;
      return {
        ...segment,
        index,
        start: roundTime(Math.max(0, start)),
        end: roundTime(Math.max(0, end)),
        speakerLabel: segment.speakerLabel || segment.speaker || "Unknown",
        text: String(segment.text || "").trim(),
        source,
        merge: {
          source,
          originalIndex: segment.index ?? index,
          originalStart: segment.start ?? null,
          originalEnd: segment.end ?? null
        }
      };
    });
}

function findDuplicate(existingSegments, candidate) {
  let best = null;
  let bestScore = 0;
  for (const existing of existingSegments) {
    const overlap = temporalOverlapRatio(existing, candidate);
    const startGap = Math.abs((existing.start || 0) - (candidate.start || 0));
    const similarity = textSimilarity(existing.text, candidate.text);
    const duplicate =
      (overlap >= 0.25 && similarity >= 0.5) ||
      (startGap <= 2.5 && similarity >= 0.45) ||
      (overlap >= 0.6 && similarity >= 0.35);
    const score = overlap + similarity - Math.min(startGap / 30, 0.5);
    if (duplicate && score > bestScore) {
      best = existing;
      bestScore = score;
    }
  }
  return best;
}

function mergePair(primary, secondary) {
  const preferredText = chooseText(primary.text, secondary.text);
  const preferredLabel = chooseSpeakerLabel(primary.speakerLabel, secondary.speakerLabel);
  return {
    ...primary,
    start: roundTime(Math.min(primary.start || 0, secondary.start || 0)),
    end: roundTime(Math.max(primary.end || primary.start || 0, secondary.end || secondary.start || 0)),
    speakerLabel: preferredLabel,
    text: preferredText,
    source: "merged",
    merge: {
      source: "merged",
      primary: {
        source: primary.source,
        speakerLabel: primary.speakerLabel,
        text: primary.text,
        originalIndex: primary.merge?.originalIndex ?? primary.index ?? null
      },
      secondary: {
        source: secondary.source,
        speakerLabel: secondary.speakerLabel,
        text: secondary.text,
        originalIndex: secondary.merge?.originalIndex ?? secondary.index ?? null
      }
    }
  };
}

function chooseSpeakerLabel(primaryLabel, secondaryLabel) {
  const primaryGeneric = isGenericLabel(primaryLabel);
  const secondaryGeneric = isGenericLabel(secondaryLabel);
  if (primaryGeneric && !secondaryGeneric) return secondaryLabel;
  if (!primaryGeneric && secondaryGeneric) return primaryLabel;
  if (!primaryGeneric && !secondaryGeneric) return primaryLabel;
  return primaryLabel || secondaryLabel || "Unknown";
}

function chooseText(primaryText, secondaryText) {
  const primary = String(primaryText || "").trim();
  const secondary = String(secondaryText || "").trim();
  if (!primary) return secondary;
  if (!secondary) return primary;
  return secondary.length > primary.length * 1.15 ? secondary : primary;
}

function temporalOverlapRatio(a, b) {
  const aStart = Number(a.start || 0);
  const aEnd = Number(a.end ?? aStart);
  const bStart = Number(b.start || 0);
  const bEnd = Number(b.end ?? bStart);
  const overlap = Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
  const shortest = Math.max(0.001, Math.min(Math.max(0.001, aEnd - aStart), Math.max(0.001, bEnd - bStart)));
  return overlap / shortest;
}

function textSimilarity(a, b) {
  const left = normalizeText(a);
  const right = normalizeText(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) {
    return Math.min(left.length, right.length) / Math.max(left.length, right.length);
  }
  const leftTokens = tokenSet(left);
  const rightTokens = tokenSet(right);
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection++;
  }
  const union = new Set([...leftTokens, ...rightTokens]).size || 1;
  return intersection / union;
}

function tokenSet(text) {
  if (text.length <= 2) return new Set([text]);
  const tokens = new Set();
  for (let i = 0; i < text.length - 1; i++) {
    tokens.add(text.slice(i, i + 2));
  }
  return tokens;
}

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[ \t\r\n　。、，,.！？!?「」『』（）()[\]【】:：;；"'“”‘’]/g, "")
    .trim();
}

function isGenericLabel(label) {
  const value = String(label || "").trim();
  if (!value) return true;
  return GENERIC_LABELS.some(pattern => pattern.test(value));
}

function getStartOffsetSeconds(primaryStartedAt, secondaryStartedAt) {
  const primary = Date.parse(primaryStartedAt || "");
  const secondary = Date.parse(secondaryStartedAt || "");
  if (!Number.isFinite(primary) || !Number.isFinite(secondary)) return 0;
  return Math.round((secondary - primary) / 1000);
}

function roundTime(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

module.exports = {
  mergeTranscripts,
  isGenericLabel,
  textSimilarity,
  temporalOverlapRatio
};
