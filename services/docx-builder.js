// ============================================================
// .docx Builder
// ============================================================
// Markdown (議事録) を Word ドキュメント (.docx) に変換。
// docx npm package を使用。
//
// 出力: storage/minutes/<jobId>.docx
// ============================================================

const fs = require("fs");
const path = require("path");
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle
} = require("docx");

const MINUTES_DIR = path.join(__dirname, "..", "storage", "minutes");
if (!fs.existsSync(MINUTES_DIR)) fs.mkdirSync(MINUTES_DIR, { recursive: true });

/**
 * Markdown と meta から .docx を生成して保存。
 *
 * @param {object} args
 * @param {string} args.jobId
 * @param {object} args.meta  - { title, started_at, ended_at, room_id, ... }
 * @param {object} args.summary - { speakerCount, wordCount, segmentCount }
 * @param {string} args.markdown - Claude が生成した議事録 Markdown
 * @returns {Promise<{ path: string, size: number }>}
 */
async function buildDocx({ jobId, meta, summary, markdown }) {
  const filePath = path.join(MINUTES_DIR, `${jobId}.docx`);

  const children = [];

  // ── タイトル
  children.push(
    new Paragraph({
      text: "会議議事録",
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { after: 300 }
    })
  );

  // ── メタ情報テーブル
  const metaRows = [
    ["会議名",       meta?.title || "(無題)"],
    ["日時",         `${meta?.started_at || "—"}  〜  ${meta?.ended_at || "—"}`],
    ["場所(会議室ID)", meta?.room_id || "—"],
    ["端末ID",       meta?.device_id || "—"],
    ["話者数 (推定)", `${summary?.speakerCount || 0} 名`],
    ["発言セグメント数", `${summary?.segmentCount || 0} 件`],
    ["言語",         meta?.language || "ja-JP"]
  ];

  children.push(buildMetaTable(metaRows));
  children.push(emptyPara());

  // ── 区切り
  children.push(buildHr());
  children.push(emptyPara());

  // ── Markdown 本文を Paragraph 化
  const mdParas = markdownToParagraphs(markdown);
  for (const p of mdParas) children.push(p);

  // ── フッター
  children.push(emptyPara());
  children.push(buildHr());
  children.push(new Paragraph({
    children: [
      new TextRun({ text: "本議事録は OccupancyCounter Auto-Minutes により自動生成されました", italics: true, size: 18, color: "666666" }),
      new TextRun({ text: `  生成: ${new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}`, italics: true, size: 18, color: "666666" })
    ]
  }));

  const doc = new Document({
    creator: "OccupancyCounter",
    title:   meta?.title || "議事録",
    description: `Job ID: ${jobId}`,
    styles: {
      default: {
        document: {
          run: { font: "Yu Gothic", size: 22 } // 11pt
        }
      }
    },
    sections: [{
      properties: { page: { margin: { top: 1000, right: 1200, bottom: 1000, left: 1200 } } },
      children
    }]
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(filePath, buffer);

  return { path: filePath, size: buffer.length, filename: `${jobId}.docx` };
}

// ─── ヘルパー ────────────────────────────────────────────────────

function emptyPara() {
  return new Paragraph({ spacing: { after: 100 } });
}

function buildHr() {
  return new Paragraph({
    border: { bottom: { color: "999999", space: 1, style: BorderStyle.SINGLE, size: 6 } }
  });
}

function buildMetaTable(rows) {
  return new Table({
    width: { size: 9000, type: WidthType.DXA },
    rows: rows.map(([label, value]) => new TableRow({
      children: [
        new TableCell({
          width: { size: 2700, type: WidthType.DXA },
          shading: { fill: "F1F5F9" },
          children: [ new Paragraph({ children: [ new TextRun({ text: label, bold: true, size: 20 }) ] }) ]
        }),
        new TableCell({
          width: { size: 6300, type: WidthType.DXA },
          children: [ new Paragraph({ children: [ new TextRun({ text: String(value), size: 20 }) ] }) ]
        })
      ]
    }))
  });
}

/**
 * Markdown を簡易パースして Paragraph[] に変換。
 * サポート:
 *   - # / ## / ### 見出し
 *   - 箇条書き (- / *)
 *   - 番号付きリスト
 *   - **太字**
 *   - 通常テキスト
 *   - 表 (| ... |)
 */
function markdownToParagraphs(md) {
  const lines = (md || "").split("\n");
  const paras = [];
  let inTable = false;
  let tableLines = [];

  const flushTable = () => {
    if (tableLines.length > 0) {
      paras.push(buildMarkdownTable(tableLines));
      tableLines = [];
    }
    inTable = false;
  };

  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (/^\s*\|.*\|\s*$/.test(line)) {
      inTable = true;
      tableLines.push(line);
      continue;
    } else if (inTable) {
      flushTable();
    }

    if (/^#\s+/.test(line)) {
      paras.push(new Paragraph({
        text: line.replace(/^#\s+/, ""),
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 240, after: 120 }
      }));
    } else if (/^##\s+/.test(line)) {
      paras.push(new Paragraph({
        text: line.replace(/^##\s+/, ""),
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 200, after: 100 }
      }));
    } else if (/^###\s+/.test(line)) {
      paras.push(new Paragraph({
        text: line.replace(/^###\s+/, ""),
        heading: HeadingLevel.HEADING_3,
        spacing: { before: 160, after: 80 }
      }));
    } else if (/^\s*[-*]\s+/.test(line)) {
      paras.push(new Paragraph({
        children: parseInline(line.replace(/^\s*[-*]\s+/, "")),
        bullet: { level: 0 }
      }));
    } else if (/^\s*\d+\.\s+/.test(line)) {
      const m = line.match(/^\s*(\d+)\.\s+(.*)$/);
      paras.push(new Paragraph({
        children: [
          new TextRun({ text: `${m?.[1] || "1"}. `, bold: true }),
          ...parseInline(m?.[2] || line.replace(/^\s*\d+\.\s+/, ""))
        ]
      }));
    } else if (line.trim() === "") {
      paras.push(emptyPara());
    } else {
      paras.push(new Paragraph({ children: parseInline(line) }));
    }
  }
  flushTable();
  return paras;
}

// Markdown 表 (| col | col |) を Table に
function buildMarkdownTable(lines) {
  const dataRows = lines
    .filter(l => !/^\s*\|[\s\-\|:]+\|\s*$/.test(l)) // separator 行除外
    .map(l => l.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim()));

  if (dataRows.length === 0) return emptyPara();

  return new Table({
    width: { size: 9000, type: WidthType.DXA },
    rows: dataRows.map((cells, ri) => new TableRow({
      tableHeader: ri === 0,
      children: cells.map(c => new TableCell({
        shading: ri === 0 ? { fill: "1E3A8A" } : undefined,
        children: [ new Paragraph({
          children: [ new TextRun({
            text: c, bold: ri === 0, color: ri === 0 ? "FFFFFF" : "000000", size: 20
          }) ]
        }) ]
      }))
    }))
  });
}

// インライン書式 (**bold** など)
function parseInline(text) {
  const parts = [];
  const re = /\*\*([^*]+)\*\*/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(new TextRun(text.substring(last, m.index)));
    parts.push(new TextRun({ text: m[1], bold: true }));
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(new TextRun(text.substring(last)));
  return parts.length > 0 ? parts : [new TextRun(text)];
}

module.exports = { buildDocx, MINUTES_DIR };
