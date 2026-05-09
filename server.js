// ====================================================================
// OccupancyCounter テスト用ダッシュボードサーバー
//   - POST /ingest/headcount で Android アプリからの人数を受信
//   - device_id → 会議室 のマッピングで滞在人数を反映
//   - GET / で会議室管理風ダッシュボードを表示
//   - GET /api/state で現在状態を JSON で取得（フロントから3秒毎にポーリング）
//   - CORS 有効（GitHub Pages からのfetch対応）
// ====================================================================

const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// ─── CORS (GitHub Pages からのfetchを許可) ──────────────────────
// 必要に応じて Origin を絞り込み可能。'*' にしておけば任意オリジンから可。
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ─── 会議室マスタ（IDを変えるとレイアウトに反映される） ────────────────
const ROOMS = [
  { id: "large",   name: "大会議室",   floor: "3F", capacity: 10, nextLabel: "10:00 【社内会議】人事MT" },
  { id: "medium",  name: "中会議室",   floor: "2F", capacity: 6,  nextLabel: "17:30 【社内会議】CDA役職者会議" },
  { id: "small",   name: "小会議室",   floor: "2F", capacity: 2,  nextLabel: "16:00 安田 鍾哲 作業報告" },
  { id: "booth",   name: "個別ブース", floor: "1F", capacity: 1,  nextLabel: "" },
];

// ─── デバイス → 会議室マッピング ───────────────────────────────────
// 各会議室にIoTデバイス(Android)を1台ずつ設置する想定。
// 各デバイスの device_id (MAC形式) をここで会議室にマッピング。
// アプリ側で device_id を以下と一致させると、対応する会議室の数値が更新される。
let deviceMap = {
  "AA:11:11:11:11:11": "large",   // 大会議室   (3F・定員10)
  "3F:A8:91:0C:7B:E2": "medium",  // 中会議室   (2F・定員 6)  ← ユーザー指定
  "CC:33:33:33:33:33": "small",   // 小会議室   (2F・定員 2)
  "DD:44:44:44:44:44": "booth",   // 個別ブース (1F・定員 1)
};

// ─── 状態（メモリ保持） ────────────────────────────────────────────
const state = {
  rooms: Object.fromEntries(ROOMS.map(r => [r.id, {
    headcount: 0,
    confidence: "—",
    lastUpdate: null,
    deviceId: null,
  }])),
  history: ROOMS.reduce((acc, r) => { acc[r.id] = []; return acc; }, {}),
};

// ─── POST /ingest/headcount ─ Android からの送信を受信 ────────────
app.post("/ingest/headcount", (req, res) => {
  const { device_id, headcount, confidence } = req.body || {};

  if (!device_id || typeof headcount !== "number") {
    return res.status(400).json({ ok: false, error: "device_id と headcount(int) は必須です" });
  }

  const roomId = deviceMap[device_id];
  if (!roomId) {
    console.warn(`[ingest] 未登録のdevice_id: ${device_id} → 受信したが反映先なし`);
    return res.status(202).json({
      ok: false,
      message: `device_id ${device_id} は未登録です。POST /api/devices でマッピングしてください。`,
    });
  }

  const room = state.rooms[roomId];
  room.headcount = Math.max(0, Math.floor(headcount));
  room.confidence = confidence || "—";
  room.lastUpdate = new Date().toISOString();
  room.deviceId = device_id;

  state.history[roomId].push({ t: room.lastUpdate, n: room.headcount, c: room.confidence });
  if (state.history[roomId].length > 30) state.history[roomId].shift();

  console.log(`[ingest] ${device_id} → ${roomId} : headcount=${headcount} (${confidence})`);
  return res.json({ ok: true, room: roomId, headcount: room.headcount });
});

// ─── GET /api/state ─ ダッシュボードのポーリング用 ────────────────
app.get("/api/state", (_req, res) => {
  res.json({
    serverTime: new Date().toISOString(),
    rooms: ROOMS.map(meta => ({
      ...meta,
      ...state.rooms[meta.id],
    })),
    deviceMap,
    history: state.history,
  });
});

// ─── POST /api/devices ─ デバイスマッピングを動的に登録 ────────────
app.post("/api/devices", (req, res) => {
  const { device_id, room_id } = req.body || {};
  if (!device_id || !room_id) return res.status(400).json({ ok: false, error: "device_id と room_id は必須" });
  if (!ROOMS.find(r => r.id === room_id)) return res.status(400).json({ ok: false, error: `room_id ${room_id} は存在しません` });
  deviceMap[device_id] = room_id;
  res.json({ ok: true, deviceMap });
});

// ─── DELETE /api/state ─ 全状態リセット（テスト用） ────────────────
app.delete("/api/state", (_req, res) => {
  ROOMS.forEach(r => {
    state.rooms[r.id] = { headcount: 0, confidence: "—", lastUpdate: null, deviceId: null };
    state.history[r.id] = [];
  });
  res.json({ ok: true });
});

// ─── ヘルスチェック ────────────────────────────────────────────────
app.get("/healthz", (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.listen(PORT, "0.0.0.0", () => {
  console.log("════════════════════════════════════════════════════════");
  console.log(`  OccupancyCounter Test Dashboard`);
  console.log(`  Listening on http://localhost:${PORT}`);
  console.log("");
  console.log("  Endpoints:");
  console.log(`    POST /ingest/headcount   - Android アプリからのカウント受信`);
  console.log(`    GET  /                   - ダッシュボード(同梱版)`);
  console.log(`    DELETE /api/state        - 状態リセット`);
  console.log("");
  console.log(`  CORS Origin: ${process.env.CORS_ORIGIN || "*"}`);
  console.log("");
  console.log("  Device mapping:");
  Object.entries(deviceMap).forEach(([d, r]) => console.log(`    ${d}  ->  ${r}`));
  console.log("════════════════════════════════════════════════════════");
});
