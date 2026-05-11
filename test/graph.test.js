const assert = require("node:assert/strict");
const test = require("node:test");

const { parseVttToSegments, sanitizeFilename } = require("../services/graph");

test("parseVttToSegments handles Teams VTT speaker variants", () => {
  const vtt = `WEBVTT

00:00:01.000 --> 00:00:05.000
<v 田中>開始します。</v>

00:00:05,500 --> 00:00:07,250
<v 鈴木>閉じタグなしでも話者を取る

00:00:08.000 --> 00:00:10.000
<c.colorE5E5E5>タグだけの発言</c>`;

  const segments = parseVttToSegments(vtt);

  assert.deepEqual(segments, [
    { start: 1, end: 5, speakerLabel: "田中", text: "開始します。" },
    { start: 5.5, end: 7.25, speakerLabel: "鈴木", text: "閉じタグなしでも話者を取る" },
    { start: 8, end: 10, speakerLabel: "Unknown", text: "タグだけの発言" }
  ]);
});

test("sanitizeFilename replaces OneDrive-problematic characters", () => {
  assert.equal(
    sanitizeFilename('a/b\\c:d*e?f"g<h>i|j#k%l.docx'),
    "a_b_c_d_e_f_g_h_i_j_k_l.docx"
  );
});
