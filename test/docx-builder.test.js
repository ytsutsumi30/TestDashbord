const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const JSZip = require("jszip");

const docxBuilder = require("../services/docx-builder");
const { withTranscriptAppendix } = require("../services/job-processor");

const repoRoot = path.resolve(__dirname, "..");

test("withTranscriptAppendix appends exact transcript rows to markdown", () => {
  const markdown = withTranscriptAppendix("# 会議サマリ\n\n要約です。", [
    { start: 0, speakerLabel: "田中", text: "開始します。" },
    { start: 61, speakerLabel: "鈴木", text: "A|B を確認します。" }
  ]);

  assert.match(markdown, /## 文字起こし全文/);
  assert.match(markdown, /\| 00:00:00 \| 田中 \| 開始します。 \|/);
  assert.match(markdown, /\| 00:01:01 \| 鈴木 \| A\\\|B を確認します。 \|/);
});

test("buildDocx avoids invalid numbering references in generated Word XML", async (t) => {
  const jobId = `docx-unit-${process.pid}-${Date.now()}`;
  t.after(() => {
    fs.rmSync(path.join(repoRoot, "storage", "minutes", `${jobId}.docx`), { force: true });
  });

  const result = await docxBuilder.buildDocx({
    jobId,
    meta: {
      title: "DOCX Unit",
      started_at: "2026-05-13T01:00:00+09:00",
      ended_at: "2026-05-13T01:10:00+09:00",
      room_id: "test",
      language: "ja-JP"
    },
    summary: { speakerCount: 2, wordCount: 10, segmentCount: 2 },
    markdown: "# 見出し\n\n1. 番号付き項目\n\n| 担当 | 内容 |\n|---|---|\n| 田中 | 確認 |"
  });

  const zip = await JSZip.loadAsync(fs.readFileSync(result.path));
  const documentXml = await zip.file("word/document.xml").async("string");
  assert.doesNotMatch(documentXml, /\{default-numbering-0\}/);
  assert.doesNotMatch(documentXml, /w:type="pct" w:w="100%"/);
  assert.match(documentXml, /番号付き項目/);
});
