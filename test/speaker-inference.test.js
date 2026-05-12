const assert = require("node:assert/strict");
const test = require("node:test");

const { applyHeuristic, extractExplicitSpeaker, inferSpeakers, UNKNOWN } = require("../services/speaker-inference");

test("extractExplicitSpeaker detects Japanese name prefixes", () => {
  assert.deepEqual(
    extractExplicitSpeaker("田中さん：進捗を共有します。"),
    { name: "田中", text: "進捗を共有します。" }
  );
  assert.deepEqual(
    extractExplicitSpeaker("Sato: I will check it."),
    { name: "Sato", text: "I will check it." }
  );
  assert.equal(extractExplicitSpeaker("議題: コスト確認"), null);
});

test("applyHeuristic relabels same-mic transcript conservatively", () => {
  const result = applyHeuristic([
    { start: 0, end: 5, speakerLabel: "会議室マイク", text: "田中：本日の会議を始めます。" },
    { start: 6, end: 9, speakerLabel: "会議室マイク", text: "まず進捗から確認します。" },
    { start: 40, end: 45, speakerLabel: "会議室マイク", text: "確認事項があります。" },
    { start: 46, end: 50, speakerLabel: "会議室マイク", text: "佐藤: テストは完了しています。" }
  ]);

  assert.equal(result.segments[0].speakerLabel, "田中");
  assert.equal(result.segments[0].text, "本日の会議を始めます。");
  assert.equal(result.segments[1].speakerLabel, "田中");
  assert.equal(result.segments[1].speakerInference.source, "context_continuation");
  assert.equal(result.segments[2].speakerLabel, UNKNOWN);
  assert.equal(result.segments[3].speakerLabel, "佐藤");
});

test("inferSpeakers leaves already-separated transcripts unchanged", async () => {
  const segments = [
    { start: 0, end: 5, speakerLabel: "田中", text: "開始します。" },
    { start: 6, end: 8, speakerLabel: "佐藤", text: "了解です。" }
  ];

  const result = await inferSpeakers({ meta: {}, segments });

  assert.equal(result.summary.applied, false);
  assert.equal(result.summary.reason, "already_separated");
  assert.equal(result.segments, segments);
});
