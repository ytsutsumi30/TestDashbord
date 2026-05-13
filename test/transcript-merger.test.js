const assert = require("node:assert/strict");
const test = require("node:test");

const { mergeTranscripts, textSimilarity } = require("../services/transcript-merger");

test("mergeTranscripts deduplicates overlapping utterances and appends room-only segments", () => {
  const result = mergeTranscripts({
    primarySource: "teams",
    secondarySource: "room_recording",
    primaryMeta: { started_at: "2026-05-13T10:00:00.000Z" },
    secondaryMeta: { started_at: "2026-05-13T10:00:00.000Z" },
    primarySegments: [
      { start: 0, end: 4, speakerLabel: "会議室マイク", text: "本日の会議を始めます。" },
      { start: 8, end: 12, speakerLabel: "鈴木", text: "進捗は予定通りです。" }
    ],
    secondarySegments: [
      { start: 0.2, end: 4.2, speakerLabel: "田中", text: "本日の会議を始めます。" },
      { start: 13, end: 16, speakerLabel: "佐藤", text: "追加でログ確認をお願いします。" }
    ]
  });

  assert.equal(result.summary.applied, true);
  assert.equal(result.summary.mergedCount, 1);
  assert.equal(result.summary.appendedCount, 1);
  assert.equal(result.segments.length, 3);
  assert.deepEqual(result.segments.map(segment => segment.speakerLabel), ["田中", "鈴木", "佐藤"]);
  assert.equal(result.segments[0].source, "merged");
});

test("textSimilarity handles Japanese sentence variants", () => {
  assert.ok(textSimilarity("本日の会議を始めます。", "本日の会議を始めます") > 0.9);
  assert.ok(textSimilarity("進捗は予定通りです。", "まったく別の議題です。") < 0.4);
});
