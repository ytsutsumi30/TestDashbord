// ============================================================
// Transcript-based speaker inference
// ============================================================
// Teams 会議室マイクなど、Graph transcript の speakerLabel が全行同一に
// なるケース向けの保守的な補正。
//
// 方針:
// - 既に複数話者が分かれている transcript は変更しない。
// - 「田中: ...」「佐藤さん：...」のような明示的 prefix は高信頼で採用。
// - prefix 直後の短い連続発言だけ、文脈継続として同一話者にする。
// - 根拠がない行は「話者未識別」とし、個人名を捏造しない。
// - SPEAKER_INFERENCE_LLM=true かつ Claude API 有効時のみ LLM 推定も試す。
// ============================================================

const claude = require("./claude");

const UNKNOWN = "話者未識別";
const CONTINUATION_GAP_SEC = Number(process.env.SPEAKER_INFERENCE_CONTINUATION_GAP_SEC || 15);
const LLM_ENABLED = (process.env.SPEAKER_INFERENCE_LLM || "").toLowerCase() === "true";
const LLM_MIN_CONFIDENCE = Number(process.env.SPEAKER_INFERENCE_LLM_MIN_CONFIDENCE || 0.75);

async function inferSpeakers({ meta, segments }) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return { segments: [], summary: { applied: false, reason: "empty" } };
  }

  const labels = distinctLabels(segments);
  if (labels.length > 1 && !labels.every(isGenericLabel)) {
    return {
      segments,
      summary: { applied: false, reason: "already_separated", originalSpeakerCount: labels.length }
    };
  }

  const heuristic = applyHeuristic(segments);
  let inferredSegments = heuristic.segments;
  let source = "heuristic";

  if (LLM_ENABLED && !claude.isMock()) {
    try {
      const estimates = await claude.estimateSpeakerLabels({ meta, segments });
      const llm = applyLlmEstimates(inferredSegments, estimates);
      if (llm.appliedCount > heuristic.appliedCount) {
        inferredSegments = llm.segments;
        source = "llm";
      }
    } catch (err) {
      console.warn(`[speaker-inference] LLM inference skipped: ${err.message}`);
    }
  }

  const inferredLabels = distinctLabels(inferredSegments);
  return {
    segments: inferredSegments,
    summary: {
      applied: true,
      source,
      reason: "single_or_generic_speaker_label",
      originalSpeakerCount: labels.length,
      inferredSpeakerCount: inferredLabels.length,
      appliedCount: inferredSegments.filter(s => s.speakerInference?.source !== "unknown").length,
      unknownCount: inferredSegments.filter(s => s.speakerLabel === UNKNOWN).length,
      note: "Text-only inference cannot prove speaker identity. Review required."
    }
  };
}

function applyHeuristic(segments) {
  let lastSpeaker = null;
  let lastEnd = null;
  let appliedCount = 0;

  const inferred = segments.map(segment => {
    const originalLabel = segment.speakerLabel || "Unknown";
    const explicit = extractExplicitSpeaker(segment.text || "");
    if (explicit) {
      lastSpeaker = explicit.name;
      lastEnd = segment.end ?? segment.start ?? null;
      appliedCount++;
      return {
        ...segment,
        speakerOriginalLabel: originalLabel,
        speakerLabel: explicit.name,
        text: explicit.text,
        speakerInference: {
          source: "explicit_text_prefix",
          confidence: 0.95,
          reason: "発言冒頭の話者名を検出"
        }
      };
    }

    const gap = lastEnd == null || segment.start == null ? Infinity : Math.max(0, segment.start - lastEnd);
    if (lastSpeaker && gap <= CONTINUATION_GAP_SEC) {
      lastEnd = segment.end ?? segment.start ?? lastEnd;
      appliedCount++;
      return {
        ...segment,
        speakerOriginalLabel: originalLabel,
        speakerLabel: lastSpeaker,
        speakerInference: {
          source: "context_continuation",
          confidence: 0.65,
          reason: `直前の明示話者から${Math.round(gap)}秒以内の継続発言`
        }
      };
    }

    lastSpeaker = null;
    lastEnd = segment.end ?? segment.start ?? null;
    return {
      ...segment,
      speakerOriginalLabel: originalLabel,
      speakerLabel: UNKNOWN,
      speakerInference: {
        source: "unknown",
        confidence: 0,
        reason: "テキスト上の話者根拠なし"
      }
    };
  });

  return { segments: inferred, appliedCount };
}

function applyLlmEstimates(segments, estimates) {
  const byIndex = new Map(
    (Array.isArray(estimates) ? estimates : [])
      .filter(e => Number.isInteger(e.index))
      .map(e => [e.index, e])
  );
  let appliedCount = 0;
  const inferred = segments.map((segment, index) => {
    const estimate = byIndex.get(index);
    const confidence = Number(estimate?.confidence || 0);
    const label = String(estimate?.speakerLabel || "").trim();
    if (!label || label === UNKNOWN || confidence < LLM_MIN_CONFIDENCE) return segment;
    appliedCount++;
    return {
      ...segment,
      speakerLabel: label,
      speakerInference: {
        source: "llm_text_inference",
        confidence,
        reason: estimate.reason || "LLM text inference"
      }
    };
  });
  return { segments: inferred, appliedCount };
}

function extractExplicitSpeaker(text) {
  const trimmed = String(text || "").trim();
  const match = trimmed.match(/^([一-龠々ぁ-んァ-ヶA-Za-z][一-龠々ぁ-んァ-ヶA-Za-z0-9・.\s]{0,18}?)(?:さん|氏|様|部長|課長|係長)?\s*[：:]\s*(.+)$/u);
  if (!match) return null;
  const name = match[1].trim();
  const body = match[2].trim();
  if (!isPlausibleName(name) || !body) return null;
  return { name, text: body };
}

function isPlausibleName(name) {
  if (!name || name.length > 20) return false;
  if (/^(http|https|todo|note|議題|決定事項|アクション)$/i.test(name)) return false;
  return true;
}

function distinctLabels(segments) {
  return Array.from(new Set(segments.map(s => s.speakerLabel || "Unknown")));
}

function isGenericLabel(label) {
  return /^(unknown|speaker\s*\d+|会議室|room|meeting|microsoft teams|teams|話者未識別)$/i.test(String(label || "").trim());
}

module.exports = {
  UNKNOWN,
  inferSpeakers,
  applyHeuristic,
  extractExplicitSpeaker,
  isGenericLabel
};
