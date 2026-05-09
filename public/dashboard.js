// ============================================================
// Dashboard polling & rendering
// ============================================================

const POLL_INTERVAL_MS = 3000;

const ROOM_COLOR = {
  large:  "#4d8cff",
  medium: "#36e08c",
  small:  "#f5a623",
  booth:  "#b58cff",
};

let lastEntryCount = 0;

async function poll() {
  try {
    const res = await fetch("/api/state", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    render(data);
  } catch (e) {
    console.warn("poll failed", e);
  }
}

function render(data) {
  // --- Available count
  const vacant = data.rooms.filter(r => r.headcount === 0).length;
  document.getElementById("availableNum").textContent = vacant;
  document.getElementById("vacancyText").textContent = vacant + "室空き";

  // --- Room cards
  const roomsEl = document.getElementById("roomsGrid");
  roomsEl.innerHTML = data.rooms.map(r => roomCardHtml(r)).join("");

  // --- Updated tag
  const t = new Date(data.serverTime);
  document.getElementById("updatedTag").textContent =
    String(t.getHours()).padStart(2, "0") + ":" +
    String(t.getMinutes()).padStart(2, "0") + ":" +
    String(t.getSeconds()).padStart(2, "0") + " 更新";

  // --- Today label
  document.getElementById("todayLabel").textContent =
    `${t.getFullYear()}/${String(t.getMonth() + 1).padStart(2, "0")}/${String(t.getDate()).padStart(2, "0")} (${["日","月","火","水","木","金","土"][t.getDay()]})`;

  // --- Hour axis (08:00 - 21:00)
  if (!document.getElementById("hourAxis").innerHTML) {
    const ax = document.getElementById("hourAxis");
    ax.innerHTML = '<div></div>' + Array.from({length:13}, (_,i)=>`<div>${String(8+i).padStart(2,"0")}</div>`).join("");
  }

  // --- Device map (各会議室の現在値も併記)
  const map = data.deviceMap || {};
  const mapEl = document.getElementById("deviceMapView");
  const roomOrder = ["large", "medium", "small", "booth"];
  const sortedEntries = Object.entries(map).sort((a, b) => {
    return roomOrder.indexOf(a[1]) - roomOrder.indexOf(b[1]);
  });
  const pad2 = n => String(n).padStart(2, "0");
  mapEl.innerHTML = '<div style="margin-bottom:6px">📌 <b>デバイスマッピング</b> (各会議室1台ずつ):</div>' +
    sortedEntries.map(([d, r]) => {
      const room = data.rooms.find(x => x.id === r);
      if (!room) return `<div class="map-row"><code>${d}</code> → <b>${r}</b> (未定義)</div>`;
      const live = room.lastUpdate ? "live" : "idle";
      const dot = live === "live"
        ? '<span style="color:#36e08c">●</span>'
        : '<span style="color:#475569">○</span>';
      let valueLabel = '<span style="color:#475569">待機中</span>';
      if (room.lastUpdate) {
        const confColor = room.confidence === "confirmed" ? "#36e08c" :
                          room.confidence === "tentative" ? "#b58cff" : "#94a3b8";
        const t = new Date(room.lastUpdate);
        const ts = `${pad2(t.getHours())}:${pad2(t.getMinutes())}:${pad2(t.getSeconds())}`;
        valueLabel = `<b style="color:#fff">${room.headcount}/${room.capacity}</b>` +
                     ` <span style="color:${confColor}">[${room.confidence}]</span>` +
                     ` <span style="color:#64748b">@ ${ts}</span>`;
      }
      return `<div class="map-row">${dot} <code>${d}</code> → <b style="color:#${live==="live"?"e2e8f0":"94a3b8"}">${room.name}</b> &nbsp; ${valueLabel}</div>`;
    }).join("") || '<div>未登録</div>';

  // --- Trend chart
  drawChart(data);

  // --- Ingest log
  drawLog(data);
}

function roomCardHtml(r) {
  const filled = r.headcount > 0;
  const full = r.headcount >= r.capacity;
  const cls = full ? "full" : (filled ? "busy" : "");
  const live = r.lastUpdate ? "live" : "";
  const badge = full
    ? '<span class="badge full">満席</span>'
    : filled
      ? '<span class="badge busy">使用中</span>'
      : '<span class="badge vacant">空き</span>';

  const conf = r.confidence === "tentative"
    ? '<span class="badge tentative" style="margin-left:6px">tentative</span>'
    : "";

  const next = r.nextLabel ? `<div class="next-line"><span class="arrow">▸</span>次▸ ${r.nextLabel}</div>` : "";

  return `
    <div class="room ${cls} ${live}">
      <div class="room-head">
        <div>
          <div class="room-name">${r.name}</div>
          <div class="room-meta">${r.floor}・定員${r.capacity}名</div>
        </div>
        <div>${badge}${conf}</div>
      </div>
      <div class="headcount">
        <span class="n">${r.headcount}</span>
        <span class="of">/ ${r.capacity}</span>
      </div>
      ${next}
    </div>`;
}

function drawChart(data) {
  const c = document.getElementById("trendChart");
  const ctx = c.getContext("2d");
  c.width = c.clientWidth;
  c.height = 180;
  ctx.clearRect(0, 0, c.width, c.height);

  // axis
  ctx.strokeStyle = "#1f2d4d";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(36, 8); ctx.lineTo(36, c.height - 24);
  ctx.lineTo(c.width - 8, c.height - 24);
  ctx.stroke();

  // y labels
  ctx.fillStyle = "#8794b3";
  ctx.font = "10px Consolas";
  const maxY = Math.max(2, ...data.rooms.map(r => r.capacity));
  for (let i = 0; i <= maxY; i += Math.max(1, Math.ceil(maxY / 5))) {
    const y = c.height - 24 - (i / maxY) * (c.height - 40);
    ctx.fillText(i, 8, y + 3);
    ctx.strokeStyle = "rgba(255,255,255,0.04)";
    ctx.beginPath(); ctx.moveTo(36, y); ctx.lineTo(c.width - 8, y); ctx.stroke();
  }

  // lines per room
  data.rooms.forEach(r => {
    const hist = data.history[r.id] || [];
    if (hist.length < 1) return;
    ctx.strokeStyle = ROOM_COLOR[r.id] || "#fff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    hist.forEach((p, i) => {
      const x = 36 + (i / Math.max(1, hist.length - 1)) * (c.width - 44);
      const y = c.height - 24 - (p.n / maxY) * (c.height - 40);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // dots
    ctx.fillStyle = ROOM_COLOR[r.id];
    hist.forEach((p, i) => {
      const x = 36 + (i / Math.max(1, hist.length - 1)) * (c.width - 44);
      const y = c.height - 24 - (p.n / maxY) * (c.height - 40);
      ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
    });
  });
}

function drawLog(data) {
  const all = [];
  data.rooms.forEach(r => {
    (data.history[r.id] || []).forEach(p => {
      all.push({ ...p, room: r.name, roomId: r.id });
    });
  });
  all.sort((a, b) => b.t.localeCompare(a.t));
  const slice = all.slice(0, 50);
  if (slice.length === lastEntryCount) return;
  lastEntryCount = slice.length;

  const log = document.getElementById("ingestLog");
  log.innerHTML = slice.map(p => {
    const t = new Date(p.t);
    const ts = `${String(t.getHours()).padStart(2,"0")}:${String(t.getMinutes()).padStart(2,"0")}:${String(t.getSeconds()).padStart(2,"0")}`;
    return `<div class="entry ${p.c}"><span class="t">[${ts}]</span> → <span class="room">${p.room}</span> headcount=<b>${p.n}</b> confidence=<span class="c">${p.c}</span></div>`;
  }).join("") || '<div class="entry"><span class="t">受信待ち...</span></div>';
}

async function resetState() {
  if (!confirm("すべての会議室の人数をリセットしますか？")) return;
  await fetch("/api/state", { method: "DELETE" });
  poll();
}

// initial + interval
poll();
setInterval(poll, POLL_INTERVAL_MS);
