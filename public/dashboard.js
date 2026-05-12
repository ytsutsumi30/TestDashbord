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
let selectedJobId = null;
let lastJobsSignature = "";
let lastSpeakerProfilesSignature = "";
let micRecorder = null;
let micRecorderStream = null;
let micRecorderChunks = [];
let micRecordingStartedAt = 0;
let micRecordingObjectUrl = null;

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

async function pollJobs() {
  try {
    const res = await fetch("/api/jobs", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    renderJobs(data.jobs || []);
  } catch (e) {
    console.warn("jobs poll failed", e);
    const list = document.getElementById("jobsList");
    if (list) list.innerHTML = '<div class="empty-state">ジョブ取得に失敗しました</div>';
  }
}

async function pollSpeakerProfiles() {
  try {
    const res = await fetch("/api/speaker-profiles", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    renderSpeakerProfiles(data.profiles || []);
  } catch (e) {
    console.warn("speaker profiles poll failed", e);
    const list = document.getElementById("speakerProfileList");
    if (list) list.innerHTML = `<div class="empty-state">話者profile取得に失敗しました: ${escapeHtml(e.message)}</div>`;
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

function renderJobs(jobs) {
  const list = document.getElementById("jobsList");
  if (!list) return;

  const signature = jobs.map(j => `${j.jobId}:${j.status}:${j.speakerCount || ""}:${j.error || ""}`).join("|");
  if (signature === lastJobsSignature) return;
  lastJobsSignature = signature;

  if (!jobs.length) {
    selectedJobId = null;
    list.innerHTML = '<div class="empty-state">議事録ジョブはまだありません</div>';
    document.getElementById("jobDetail").innerHTML = '<div class="empty-state">録音アップロード後にここへ表示されます</div>';
    return;
  }

  if (!selectedJobId || !jobs.some(j => j.jobId === selectedJobId)) {
    selectedJobId = jobs[0].jobId;
    loadJobDetail(selectedJobId);
  }

  list.innerHTML = jobs.map(j => {
    const selected = j.jobId === selectedJobId ? "selected" : "";
    const created = formatDateTime(j.createdAt);
    return `
      <button class="job-row ${selected}" onclick="selectJob('${escapeAttr(j.jobId)}')">
        <div class="job-row-top">
          <span class="job-title">${escapeHtml(j.title || j.jobId)}</span>
          <span class="status-badge ${statusClass(j.status)}">${escapeHtml(j.status)}</span>
        </div>
      <div class="job-row-meta">
          ${escapeHtml(created)} / ${escapeHtml(j.roomId || "room未設定")} / speakers=${escapeHtml(j.speakerCount ?? "—")}${j.speakerIdentification?.applied ? " / 音声識別あり" : ""}${j.speakerInference?.applied ? " / 推定あり" : ""}
      </div>
        ${j.error ? `<div class="job-error">${escapeHtml(j.error)}</div>` : ""}
      </button>`;
  }).join("");

  if (selectedJobId) loadJobDetail(selectedJobId);
}

function selectJob(jobId) {
  selectedJobId = jobId;
  lastJobsSignature = "";
  pollJobs();
  loadJobDetail(jobId);
}

async function loadJobDetail(jobId) {
  const detail = document.getElementById("jobDetail");
  detail.innerHTML = '<div class="empty-state">読み込み中...</div>';
  try {
    const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const job = await res.json();
    detail.innerHTML = jobDetailHtml(job);
  } catch (e) {
    detail.innerHTML = `<div class="empty-state">詳細取得に失敗しました: ${escapeHtml(e.message)}</div>`;
  }
}

function jobDetailHtml(job) {
  const minutes = job.minutes;
  const onedrive = minutes?.onedrive;
  const download = minutes?.downloadUrl
    ? `<a class="action-link" href="${escapeAttr(minutes.downloadUrl)}">DOCX ダウンロード</a>`
    : '<span class="muted-text">DOCX未生成</span>';
  const markdown = minutes?.markdownUrl
    ? `<button class="action-link button-link" onclick="loadMarkdownPreview('${escapeAttr(job.jobId)}')">Markdownプレビュー</button>`
    : "";
  const share = onedrive?.shareUrl
    ? `<a class="action-link" href="${escapeAttr(onedrive.shareUrl)}" target="_blank" rel="noopener">OneDrive共有リンク</a>`
    : onedrive?.webUrl
      ? `<a class="action-link" href="${escapeAttr(onedrive.webUrl)}" target="_blank" rel="noopener">OneDriveを開く</a>`
      : "";

  return `
    <div class="detail-head">
      <div>
        <div class="detail-title">${escapeHtml(job.meta?.title || job.jobId)}</div>
        <div class="detail-sub">${escapeHtml(job.jobId)} / ${escapeHtml(job.meta?.room_id || "room未設定")}</div>
      </div>
      <span class="status-badge ${statusClass(job.status)}">${escapeHtml(job.status)}</span>
    </div>
    <div class="detail-grid">
      <div><span>作成</span><b>${escapeHtml(formatDateTime(job.createdAt))}</b></div>
      <div><span>完了</span><b>${escapeHtml(formatDateTime(job.completedAt))}</b></div>
      <div><span>話者</span><b>${escapeHtml(job.transcript?.speakerCount ?? "—")}</b></div>
      <div><span>Mock</span><b>${job.mocked || minutes?.mocked ? "yes" : "no"}</b></div>
      <div><span>Model</span><b>${escapeHtml(minutes?.model || "—")}</b></div>
      <div><span>DOCX</span><b>${escapeHtml(formatBytes(minutes?.docxSize))}</b></div>
    </div>
    ${speakerIdentificationHtml(job.speakerIdentification)}
    ${speakerInferenceHtml(job.speakerInference)}
    ${job.error ? `<div class="detail-error">${escapeHtml(job.error)}</div>` : ""}
    <div class="detail-actions">${download}${markdown}${share}</div>
    <pre class="markdown-preview" id="markdownPreview">Markdownプレビューは未表示です。</pre>`;
}

function speakerInferenceHtml(info) {
  if (!info?.applied) return "";
  return `
    <div class="speaker-inference-note">
      話者推定: ${escapeHtml(info.source || "unknown")}
      / 推定話者数=${escapeHtml(info.inferredSpeakerCount ?? "—")}
      / 未識別=${escapeHtml(info.unknownCount ?? "—")}
      <br>${escapeHtml(info.note || "Text-only inference. Review required.")}
    </div>`;
}

function speakerIdentificationHtml(info) {
  if (!info) return "";
  const cls = info.applied ? "speaker-identification-note" : "speaker-identification-note muted";
  return `
    <div class="${cls}">
      音声話者識別: ${escapeHtml(info.reason || "unknown")}
      / 候補profile=${escapeHtml(info.candidateProfileCount ?? "—")}
      / 識別=${escapeHtml(info.identifiedCount ?? 0)}
      / 未識別=${escapeHtml(info.unknownCount ?? "—")}
      ${info.threshold != null ? `/ threshold=${escapeHtml(info.threshold)}` : ""}
      <br>${escapeHtml(info.note || "Audio-based speaker identification.")}
    </div>`;
}

async function loadMarkdownPreview(jobId) {
  const preview = document.getElementById("markdownPreview");
  preview.textContent = "Markdown読み込み中...";
  try {
    const res = await fetch(`/api/minutes/${encodeURIComponent(jobId)}/markdown`, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    preview.textContent = await res.text();
  } catch (e) {
    preview.textContent = `Markdown取得に失敗しました: ${e.message}`;
  }
}

function renderSpeakerProfiles(profiles) {
  const list = document.getElementById("speakerProfileList");
  if (!list) return;

  const signature = profiles.map(p => `${p.id}:${p.enrollmentStatus}:${p.updatedAt}:${p.error || ""}`).join("|");
  if (signature === lastSpeakerProfilesSignature) return;
  lastSpeakerProfilesSignature = signature;

  if (!profiles.length) {
    list.innerHTML = '<div class="empty-state">話者profileはまだ登録されていません</div>';
    return;
  }

  list.innerHTML = profiles.map(profile => `
    <div class="speaker-profile-card">
      <div class="speaker-profile-head">
        <div>
          <div class="speaker-profile-name">${escapeHtml(profile.displayName)}</div>
          <div class="speaker-profile-meta">${escapeHtml(profile.department || "部署未設定")} / ${escapeHtml(profile.email || "メール未設定")}</div>
        </div>
        <span class="status-badge ${statusClass(profile.enrollmentStatus)}">${escapeHtml(profile.enrollmentStatus || "unknown")}</span>
      </div>
      <div class="speaker-profile-detail">
        Azure profile: <code>${escapeHtml(profile.azureProfileId || "—")}</code><br>
        locale=${escapeHtml(profile.locale || "ja-JP")}
        / enrollments=${escapeHtml(profile.enrollmentsCount ?? 0)}
        / speech=${escapeHtml(profile.enrollmentsSpeechLengthInSec ?? "—")}s
        / remaining=${escapeHtml(profile.remainingEnrollmentsSpeechLengthInSec ?? "—")}s
        ${profile.mocked ? " / mock" : ""}
      </div>
      ${profile.error ? `<div class="job-error">${escapeHtml(profile.error)}</div>` : ""}
      <div class="speaker-profile-actions">
        <button class="mini-button" onclick="refreshSpeakerProfile('${escapeAttr(profile.id)}')">状態更新</button>
        <button class="mini-button danger" onclick="deleteSpeakerProfile('${escapeAttr(profile.id)}')">削除</button>
      </div>
      <form class="speaker-profile-enroll-form" onsubmit="enrollSpeakerProfile(event, '${escapeAttr(profile.id)}')">
        <input name="audio" type="file" accept=".wav,audio/wav" required>
        <label class="inline-checkbox"><input name="ignoreMinLength" type="checkbox"> 最小音声長を無視</label>
        <button class="mini-button" type="submit">追加音声登録</button>
      </form>
    </div>`).join("");
}

async function submitSpeakerProfileForm(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const message = document.getElementById("speakerProfileMessage");
  message.textContent = "登録中...";
  try {
    const body = new FormData(form);
    const res = await fetch("/api/speaker-profiles", { method: "POST", body });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    form.reset();
    form.elements.locale.value = "ja-JP";
    clearMicRecording();
    message.textContent = "登録しました";
    lastSpeakerProfilesSignature = "";
    renderSpeakerProfiles([data.profile]);
    pollSpeakerProfiles();
  } catch (e) {
    message.textContent = `登録失敗: ${e.message}`;
  }
}

async function startMicRecording() {
  const status = document.getElementById("micRecorderStatus");
  const startButton = document.getElementById("micStartButton");
  const stopButton = document.getElementById("micStopButton");
  const clearButton = document.getElementById("micClearButton");

  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    status.textContent = "このブラウザはマイク録音に未対応です";
    return;
  }

  try {
    clearMicRecording({ keepStatus: true });
    micRecorderStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        noiseSuppression: true,
        echoCancellation: true
      }
    });
    micRecorderChunks = [];
    micRecorder = new MediaRecorder(micRecorderStream);
    micRecorder.ondataavailable = event => {
      if (event.data?.size) micRecorderChunks.push(event.data);
    };
    micRecorder.onstop = finalizeMicRecording;
    micRecordingStartedAt = Date.now();
    micRecorder.start();

    startButton.disabled = true;
    stopButton.disabled = false;
    clearButton.disabled = true;
    status.textContent = "録音中...";
  } catch (error) {
    status.textContent = `録音開始失敗: ${error.message}`;
  }
}

function stopMicRecording() {
  const stopButton = document.getElementById("micStopButton");
  const status = document.getElementById("micRecorderStatus");
  if (micRecorder?.state === "recording") {
    stopButton.disabled = true;
    status.textContent = "WAV変換中...";
    micRecorder.stop();
  }
}

async function finalizeMicRecording() {
  const status = document.getElementById("micRecorderStatus");
  const startButton = document.getElementById("micStartButton");
  const clearButton = document.getElementById("micClearButton");
  const audioInput = document.querySelector("#speakerProfileForm input[name='audio']");
  const player = document.getElementById("micRecorderPlayer");
  const durationSec = Math.max(1, Math.round((Date.now() - micRecordingStartedAt) / 1000));

  stopMicStream();
  try {
    const recordedBlob = new Blob(micRecorderChunks, { type: micRecorder?.mimeType || "audio/webm" });
    const wavBlob = await convertRecordedBlobToWav(recordedBlob);
    const file = new File([wavBlob], `mic-enrollment-${new Date().toISOString().replace(/[:.]/g, "-")}.wav`, { type: "audio/wav" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    audioInput.files = transfer.files;

    if (micRecordingObjectUrl) URL.revokeObjectURL(micRecordingObjectUrl);
    micRecordingObjectUrl = URL.createObjectURL(file);
    player.src = micRecordingObjectUrl;
    player.classList.add("ready");

    status.textContent = `録音済み ${durationSec}秒 / ${Math.round(file.size / 1024)}KB`;
    clearButton.disabled = false;
  } catch (error) {
    status.textContent = `WAV変換失敗: ${error.message}`;
  } finally {
    startButton.disabled = false;
    micRecorder = null;
    micRecorderChunks = [];
  }
}

function clearMicRecording({ keepStatus = false } = {}) {
  const audioInput = document.querySelector("#speakerProfileForm input[name='audio']");
  const player = document.getElementById("micRecorderPlayer");
  const clearButton = document.getElementById("micClearButton");
  const status = document.getElementById("micRecorderStatus");
  stopMicStream();
  if (micRecorder?.state === "recording") micRecorder.stop();
  micRecorder = null;
  micRecorderChunks = [];
  if (audioInput) audioInput.value = "";
  if (micRecordingObjectUrl) URL.revokeObjectURL(micRecordingObjectUrl);
  micRecordingObjectUrl = null;
  if (player) {
    player.removeAttribute("src");
    player.classList.remove("ready");
  }
  if (clearButton) clearButton.disabled = true;
  if (!keepStatus && status) status.textContent = "未録音";
}

function stopMicStream() {
  if (!micRecorderStream) return;
  micRecorderStream.getTracks().forEach(track => track.stop());
  micRecorderStream = null;
}

async function convertRecordedBlobToWav(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) throw new Error("AudioContext unsupported");
  const audioContext = new AudioContextClass();
  try {
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    const monoSamples = mixToMono(audioBuffer);
    return encodePcm16Wav(monoSamples, audioBuffer.sampleRate);
  } finally {
    audioContext.close?.();
  }
}

function mixToMono(audioBuffer) {
  const channelCount = audioBuffer.numberOfChannels;
  const samples = new Float32Array(audioBuffer.length);
  for (let channel = 0; channel < channelCount; channel++) {
    const data = audioBuffer.getChannelData(channel);
    for (let i = 0; i < data.length; i++) samples[i] += data[i] / channelCount;
  }
  return samples;
}

function encodePcm16Wav(samples, sampleRate) {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

async function copyEnrollmentScript() {
  const text = document.getElementById("enrollmentScriptText")?.textContent || "";
  const status = document.getElementById("micRecorderStatus");
  try {
    await navigator.clipboard.writeText(text);
    if (status) status.textContent = "読み上げ文をコピーしました";
  } catch {
    if (status) status.textContent = "コピーに失敗しました";
  }
}

async function refreshSpeakerProfile(id) {
  await fetch(`/api/speaker-profiles/${encodeURIComponent(id)}/refresh`, { method: "POST" });
  lastSpeakerProfilesSignature = "";
  pollSpeakerProfiles();
}

async function enrollSpeakerProfile(event, id) {
  event.preventDefault();
  const form = event.currentTarget;
  const body = new FormData(form);
  const res = await fetch(`/api/speaker-profiles/${encodeURIComponent(id)}/enroll`, {
    method: "POST",
    body
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    alert(`追加音声登録に失敗しました: ${data.error || res.status}`);
    return;
  }
  form.reset();
  lastSpeakerProfilesSignature = "";
  pollSpeakerProfiles();
}

async function deleteSpeakerProfile(id) {
  if (!confirm("この話者profileを削除しますか？Azure側のprofileも削除されます。")) return;
  await fetch(`/api/speaker-profiles/${encodeURIComponent(id)}`, { method: "DELETE" });
  lastSpeakerProfilesSignature = "";
  pollSpeakerProfiles();
}

function statusClass(status) {
  return `status-${String(status || "unknown").replace(/[^a-z0-9_-]/gi, "_").toLowerCase()}`;
}

function formatDateTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function formatBytes(value) {
  if (!value) return "—";
  if (value < 1024) return `${value} B`;
  return `${Math.round(value / 1024)} KB`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

async function resetState() {
  if (!confirm("すべての会議室の人数をリセットしますか？")) return;
  await fetch("/api/state", { method: "DELETE" });
  poll();
}

// initial + interval
const speakerProfileForm = document.getElementById("speakerProfileForm");
if (speakerProfileForm) speakerProfileForm.addEventListener("submit", submitSpeakerProfileForm);
document.getElementById("micStartButton")?.addEventListener("click", startMicRecording);
document.getElementById("micStopButton")?.addEventListener("click", stopMicRecording);
document.getElementById("micClearButton")?.addEventListener("click", () => clearMicRecording());
document.getElementById("copyEnrollmentScriptButton")?.addEventListener("click", copyEnrollmentScript);
poll();
pollJobs();
pollSpeakerProfiles();
setInterval(poll, POLL_INTERVAL_MS);
setInterval(pollJobs, POLL_INTERVAL_MS);
setInterval(pollSpeakerProfiles, POLL_INTERVAL_MS * 2);
