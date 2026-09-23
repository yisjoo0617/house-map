"use strict";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const ROOM_COLORS = ["#e11d48", "#2563eb", "#16a34a", "#f59e0b", "#9333ea", "#0891b2", "#ea580c", "#4f46e5", "#65a30d", "#db2777"];

const state = {
  proj: null,
  rooms: [],
  events: [],
  track: null,
  analysis: null,
  planImgs: {},       // floor id -> Image (original plan, for editing)
  mini: null,         // server-rendered preview panels
  viewFloor: null,    // floor shown in the plan editor
  drag: null,
  tlDrag: null,
};

const video = $("#video");
const overlay = $("#overlay");
const planCv = $("#plan");
const timeline = $("#timeline");

// ---------------- API ----------------

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: opts.body && !(opts.body instanceof FormData) ? { "Content-Type": "application/json" } : {},
    ...opts,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail || msg; } catch {}
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return res.json();
}

async function pollJob(id, onProgress) {
  for (;;) {
    const job = await api(`/api/jobs/${id}`);
    onProgress?.(job);
    if (job.status === "done") return job;
    if (job.status === "error") throw new Error(job.message || "작업 실패");
    await new Promise((r) => setTimeout(r, 700));
  }
}

const fileUrl = (name, download = false) =>
  `/api/projects/${state.proj.id}/files/${name}${download ? "?download=1" : ""}`;

const floorOf = (id) => state.proj.floors.find((f) => f.id === id);
const roomColor = (room) => ROOM_COLORS[state.rooms.indexOf(room) % ROOM_COLORS.length];
const roomById = (id) => state.rooms.find((r) => r.id === id);

// ---------------- views & routing ----------------
// "#<project id>" shows the editor, an empty hash shows the project list.

function route() {
  const id = location.hash.slice(1);
  if (id) openProject(id).catch((e) => { alert("프로젝트를 열 수 없습니다: " + e.message); location.hash = ""; });
  else showList();
}
window.addEventListener("hashchange", route);
$("#homeLink").addEventListener("click", (e) => { e.preventDefault(); location.hash = ""; });
$("#helpLink").addEventListener("click", (e) => { e.preventDefault(); $("#help").classList.toggle("hidden"); });

async function showList() {
  video.pause();
  if (state.proj) await flushSaves().catch(() => {});
  state.proj = null;
  state.mini = null;
  video.removeAttribute("src");
  video.load();
  $("#workspace").classList.add("hidden");
  $("#crumb").classList.add("hidden");
  $("#listView").classList.remove("hidden");
  document.title = "House-Map";
  await refreshProjectList();
}

// ---------------- project list ----------------

async function refreshProjectList() {
  state.list = await api("/api/projects");
  renderList();
}

function renderList() {
  const items = state.list || [];
  const q = $("#search").value.trim().toLowerCase();
  const sort = $("#sort").value;
  const shown = items
    .filter((p) => !q || (p.name || "").toLowerCase().includes(q))
    .sort((a, b) => sort === "name" ? (a.name || "").localeCompare(b.name || "", "ko")
      : sort === "created" ? (b.created || "").localeCompare(a.created || "") : 0);

  $("#listCount").textContent = items.length ? `${items.length}개` : "";
  $("#emptyState").classList.toggle("hidden", items.length > 0);
  $("#noResult").classList.toggle("hidden", !items.length || shown.length > 0);
  $("#projectGrid").innerHTML = shown.map(projectCard).join("");
}

function projectCard(p) {
  const done = p.outputs.includes("overlay.mov");
  const badge = done ? `<span class="badge ok">오버레이 완료</span>`
    : p.events ? `<span class="badge wip">작업 중</span>` : `<span class="badge">이동 기록 없음</span>`;
  const thumb = p.thumb ? `style="background-image:url('/api/projects/${p.id}/files/${p.thumb}?v=${encodeURIComponent(p.updated)}')"` : "";
  const dl = done ? `<a class="btn" href="/api/projects/${p.id}/files/outputs/overlay.mov?download=1" title="overlay.mov 다운로드">⬇ 오버레이</a>` : "";
  return `
    <article class="pcard" data-id="${p.id}">
      <div class="thumb ${p.thumb?.startsWith("outputs/") ? "dark" : ""}" ${thumb}></div>
      <div class="pbody">
        <div class="ptitle"><h3>${escapeHtml(p.name || "(이름 없음)")}</h3>${badge}</div>
        <div class="meta">
          <span>🎬 ${fmtDur(p.duration)}</span>
          <span>🏠 ${escapeHtml(p.floors.join(" · ") || "-")}</span>
          <span>방 ${p.rooms} · 기록 ${p.events}</span>
          <span>💾 ${fmtSize(p.size)}</span>
        </div>
        <div class="meta muted" title="생성 ${escapeHtml(p.created || "")}">마지막 수정 ${escapeHtml(p.updated)}</div>
      </div>
      <div class="pactions">
        <button class="primary" data-act="open">편집</button>
        ${dl}
        <span class="spacer"></span>
        <button data-act="rename" title="이름 변경">✎ 이름</button>
        <button class="danger-ghost" data-act="delete" title="삭제">🗑 삭제</button>
      </div>
    </article>`;
}

$("#search").addEventListener("input", renderList);
$("#sort").addEventListener("change", renderList);

$("#projectGrid").addEventListener("click", (e) => {
  const card = e.target.closest(".pcard");
  if (!card || e.target.closest("a")) return;
  const p = state.list.find((x) => x.id === card.dataset.id);
  const act = e.target.closest("[data-act]")?.dataset.act || "open";
  if (act === "open") location.hash = p.id;
  else if (act === "rename") openRename(p.id, p.name);
  else if (act === "delete") openDelete(p);
});

// ---------------- dialogs: new / rename / delete ----------------

for (const b of $$("[data-close]")) b.addEventListener("click", () => b.closest("dialog").close());
$("#newBtn").addEventListener("click", openNew);
for (const b of $$("[data-open-new]")) b.addEventListener("click", openNew);

function openNew() {
  $("#newForm").reset();
  $("#newError").textContent = "";
  $("#uploadBox").classList.add("hidden");
  $("#createBtn").disabled = false;
  refreshPresets();
  $("#newDialog").showModal();
}

$("#newForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("#newVideo").files[0], plans = [...$("#newPlans").files];
  const fd = new FormData();
  fd.append("video", v);
  plans.forEach((p) => fd.append("plans", p));
  fd.append("name", $("#newName").value.trim());
  fd.append("labels", $("#newLabels").value);
  fd.append("preset", $("#newPreset").value);
  const prog = $("#uploadProg"), msg = $("#uploadMsg"), err = $("#newError");
  $("#uploadBox").classList.remove("hidden");
  err.textContent = "";
  $("#createBtn").disabled = true;
  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/projects");
  xhr.upload.onprogress = (ev) => {
    prog.value = ev.loaded / ev.total;
    msg.textContent = prog.value < 1 ? `업로드 ${Math.round(prog.value * 100)}%` : "영상 확인 중…";
  };
  xhr.onload = () => {
    $("#createBtn").disabled = false;
    $("#uploadBox").classList.add("hidden");
    if (xhr.status !== 200) {
      err.textContent = "실패: " + (safeJson(xhr.responseText)?.detail || xhr.statusText);
      return;
    }
    const proj = JSON.parse(xhr.responseText);
    $("#newDialog").close();
    location.hash = proj.id;
    // swap to the browser-friendly proxy once it is ready
    pollJob(proj.preview_job).then(() => state.proj?.id === proj.id && setVideoSource("preview.mp4")).catch(() => {});
  };
  xhr.onerror = () => { $("#createBtn").disabled = false; err.textContent = "업로드 실패: 서버가 실행 중인지 확인하세요"; };
  msg.textContent = "업로드 중…";
  xhr.send(fd);
});
// don't let Esc throw away an upload in progress
$("#newDialog").addEventListener("cancel", (e) => $("#createBtn").disabled && e.preventDefault());

let renameId = null;
function openRename(id, name) {
  renameId = id;
  $("#renameInput").value = name || "";
  $("#renameDialog").showModal();
  $("#renameInput").select();
}
$("#crumbRename").addEventListener("click", () => state.proj && openRename(state.proj.id, state.proj.name));

$("#renameForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#renameInput").value.trim();
  if (!name) return;
  const proj = await api(`/api/projects/${renameId}`, { method: "PUT", body: JSON.stringify({ name }) });
  $("#renameDialog").close();
  if (state.proj?.id === renameId) {
    state.proj.name = proj.name;
    state.proj.default_title = proj.default_title;
    $("#titleInput").placeholder = proj.default_title;
    showCrumb();
    refreshMinimap();
  } else {
    refreshProjectList();
  }
});

let deleteId = null;
function openDelete(p) {
  deleteId = p.id;
  $("#deleteText").innerHTML = `<b>${escapeHtml(p.name || p.id)}</b> 프로젝트를 삭제할까요? (${fmtSize(p.size)} 확보)`;
  $("#deleteDialog").showModal();
}

$("#deleteForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  await api(`/api/projects/${deleteId}`, { method: "DELETE" });
  $("#deleteDialog").close();
  if (state.proj?.id === deleteId) location.hash = "";
  else refreshProjectList();
});

function showCrumb() {
  $("#crumbName").textContent = state.proj.name;
  $("#crumb").classList.remove("hidden");
  document.title = `${state.proj.name} · House-Map`;
}

async function openProject(id) {
  if (state.proj && state.proj.id !== id) await flushSaves().catch(() => {});
  const proj = await api(`/api/projects/${id}`);
  state.viewFloor = null;
  state.undo = [];
  state.structImgs = {};
  applyProject(proj);
  state.analysis = proj.has_analysis ? await api(`/api/projects/${id}/analysis`) : null;
  $("#listView").classList.add("hidden");
  $("#workspace").classList.remove("hidden");
  $("#help").classList.add("hidden");
  showCrumb();
  setVideoSource(proj.has_preview ? "preview.mp4" : "video");
  fillSettings(proj.settings);
  renderDownloads(proj.outputs);
  $("#analyzeMsg").textContent = state.analysis ? `추천 시점 ${state.analysis.suggestions.length}개` : "";
  await Promise.all([loadPlanImages(), refreshMinimap(), refreshTrack()]);
  resizeAll();
  if (state.mode === "draw") loadStruct();
}

function applyProject(proj) {
  state.proj = proj;
  state.rooms = proj.rooms.map((r) => ({ ...r }));
  state.events = proj.events.map((e) => ({ ...e }));
  if (!state.viewFloor || !floorOf(state.viewFloor)) state.viewFloor = proj.floors[0].id;
  $("#titleInput").placeholder = proj.default_title;
  renderFloorTabs();
  renderRooms();
  renderEvents();
}

async function loadPlanImages() {
  const v = Date.now();
  const entries = await Promise.all(state.proj.floors.map(async (f) => [f.id, await loadImage(fileUrl(f.file) + `?v=${v}`)]));
  state.planImgs = Object.fromEntries(entries);
}

function setVideoSource(name) {
  const t = video.currentTime || 0;
  video.src = fileUrl(name);
  video.addEventListener("loadedmetadata", () => { video.currentTime = t; resizeAll(); }, { once: true });
}

function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
}

// ---------------- floors ----------------

function renderFloorTabs() {
  const tabs = state.proj.floors.map((f) =>
    `<button data-floor="${f.id}" class="${f.id === state.viewFloor ? "active" : ""}" title="더블클릭하여 이름 변경">${escapeHtml(f.label)}</button>`);
  tabs.push(`<button id="addFloorBtn" title="도면 이미지 추가">+ 층 추가</button>`);
  if (state.proj.floors.length > 1) tabs.push(`<button class="del" id="delFloorBtn">이 층 삭제</button>`);
  $("#floorTabs").innerHTML = tabs.join("");
  renderFloorShow();
}

// ---------------- per-floor show window (when this plan appears / disappears) ----------------

function renderFloorShow() {
  const f = floorOf(state.viewFloor);
  if (!f) return;
  const v = (x) => (x == null ? "" : fmtTime(x));
  $("#floorShow").innerHTML = `
    <span class="muted">${escapeHtml(f.label)} 도면 노출</span>
    <label>시작 <input data-show="show_start" value="${v(f.show_start)}" placeholder="영상 처음" title="이 층 도면이 나타나는 시각 (분:초 또는 초)" /></label>
    <button data-show-now="show_start" title="현재 재생 시각을 시작으로">⏺ 현재</button>
    <span class="muted">~</span>
    <label>종료 <input data-show="show_end" value="${v(f.show_end)}" placeholder="영상 끝" title="이 층 도면이 사라지는 시각 (분:초 또는 초)" /></label>
    <button data-show-now="show_end" title="현재 재생 시각을 종료로">⏺ 현재</button>
    ${f.show_start != null || f.show_end != null ? `<button data-show-clear title="이 층은 항상 노출">지우기</button>` : ""}
    <span class="muted small">${showNote(f)}</span>`;
}

// "1F 0:10 ~ 2:30" checks: a window that ends before it starts, or overlaps another floor's window
function showNote(f) {
  const a0 = f.show_start ?? 0, a1 = f.show_end ?? Infinity;
  if (a1 <= a0) return "⚠ 종료가 시작보다 앞입니다";
  for (const g of state.proj.floors) {
    if (g === f || (g.show_start == null && g.show_end == null)) continue;
    const b0 = g.show_start ?? 0, b1 = g.show_end ?? Infinity;
    if (a0 < b1 && b0 < a1) return `⚠ ${escapeHtml(g.label)} 노출 구간과 겹칩니다 (겹치는 동안은 나중에 시작한 층이 보입니다)`;
  }
  return f.show_start == null && f.show_end == null ? "구간을 정하지 않으면 마커가 이 층에 있을 때 보입니다" : "이 구간에는 마커 위치와 상관없이 이 층 도면이 보이고, 마커는 이 층에 있을 때만 나타납니다";
}

function parseTime(str) {
  const t = String(str).trim();
  if (!t) return null;
  const m = t.match(/^(\d+):(\d+(?:\.\d+)?)$/);
  const v = m ? +m[1] * 60 + +m[2] : parseFloat(t);
  return Number.isFinite(v) && v >= 0 ? +v.toFixed(2) : null;
}

$("#floorShow").addEventListener("change", (e) => {
  const inp = e.target.closest("[data-show]");
  if (!inp) return;
  const f = floorOf(state.viewFloor);
  const v = parseTime(inp.value);
  if (v == null) delete f[inp.dataset.show]; else f[inp.dataset.show] = v;
  renderFloorShow();
  saveEdits();
});
$("#floorShow").addEventListener("click", (e) => {
  const now = e.target.closest("[data-show-now]");
  const f = floorOf(state.viewFloor);
  if (now) { f[now.dataset.showNow] = +video.currentTime.toFixed(2); renderFloorShow(); saveEdits(); }
  else if (e.target.closest("[data-show-clear]")) { delete f.show_start; delete f.show_end; renderFloorShow(); saveEdits(); }
});

$("#floorTabs").addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.floor) {
    video.pause();   // while playing the editor follows the marker's floor; a manual pick stops that
    state.viewFloor = b.dataset.floor;
    renderFloorTabs();
    resizePlan();
    drawPlan();
    if (state.mode === "draw") loadStruct();
  }
  else if (b.id === "addFloorBtn") $("#addFloorFile").click();
  else if (b.id === "delFloorBtn") {
    const f = floorOf(state.viewFloor);
    if (!confirm(`${f.label} 도면과 그 층의 방·기록을 삭제할까요?`)) return;
    await flushSaves();
    applyProject(await api(`/api/projects/${state.proj.id}/floors/${f.id}`, { method: "DELETE" }));
    state.viewFloor = state.proj.floors[0].id;
    renderFloorTabs();
    await Promise.all([loadPlanImages(), refreshMinimap(), refreshTrack()]);
    resizeAll();
  }
});

$("#floorTabs").addEventListener("dblclick", (e) => {
  const b = e.target.closest("[data-floor]");
  if (!b) return;
  const f = floorOf(b.dataset.floor);
  const label = prompt("층 이름", f.label);
  if (!label) return;
  f.label = label.trim();
  renderFloorTabs();
  renderRooms();
  api(`/api/projects/${state.proj.id}`, { method: "PUT", body: JSON.stringify({ floors: state.proj.floors }) }).then(refreshMinimap);
});

$("#addFloorFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append("plan", file);
  fd.append("label", prompt("층 이름", `${state.proj.floors.length + 1}F`) || "");
  await flushSaves();
  const proj = await api(`/api/projects/${state.proj.id}/floors`, { method: "POST", body: fd });
  applyProject(proj);
  state.viewFloor = proj.floors[proj.floors.length - 1].id;
  renderFloorTabs();
  await Promise.all([loadPlanImages(), refreshMinimap()]);
  resizeAll();
  e.target.value = "";
});

// ---------------- settings ----------------

// settings that change where the marker is at a given time -> re-fetch the track
const MOVE_SETTINGS = ["transition", "fade_sec", "panel_fade_sec", "transition_sec", "move_timing", "cross_sec", "move_anchor", "line_mode", "line_threshold"];

function syncSettingLabels() {
  const s = state.proj?.settings;
  if (!s) return;
  $("#crossVal").textContent = `도면 끝→끝 ${(+s.cross_sec).toFixed(1)}초`;
  $("#transVal").textContent = `${(+s.transition_sec).toFixed(1)}초`;
  $("#fadeVal").textContent = `${(+s.fade_sec).toFixed(1)}초`;
  $("#panelFadeVal").textContent = `${(+s.panel_fade_sec).toFixed(1)}초`;
  for (const el of $$("[data-when]")) {
    const [k, v] = el.dataset.when.split("=");
    el.classList.toggle("hidden", String(s[k]) !== v);
  }
}

function fillSettings(s) {
  for (const el of $$("[data-setting]")) {
    const v = s[el.dataset.setting];
    if (el.type === "checkbox") el.checked = !!v;
    else el.value = String(v);
  }
  syncSettingLabels();
}

function readSetting(el) {
  if (el.type === "checkbox") return el.checked;
  if (el.type === "range" || el.dataset.setting === "panel_ratio") return parseFloat(el.value);
  return el.value;
}

for (const el of $$("[data-setting]")) {
  el.addEventListener("input", () => {
    if (!state.proj) return;
    state.proj.settings[el.dataset.setting] = readSetting(el);
    syncSettingLabels();
    saveSettings(MOVE_SETTINGS.includes(el.dataset.setting));
  });
}

let settingsTimer;
function saveSettings(retrack) {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(async () => {
    settingsTimer = null;
    await api(`/api/projects/${state.proj.id}`, { method: "PUT", body: JSON.stringify({ settings: state.proj.settings }) });
    await refreshMinimap();
    if (retrack) await refreshTrack();
    if (state.mode === "draw") loadStruct();
  }, 350);
}

async function refreshMinimap() {
  const m = await api(`/api/projects/${state.proj.id}/minimap`);
  const [floorImgs, shadow, glow, body] = await Promise.all([
    Promise.all(m.floors.map((f) => loadImage(f.image))),
    loadImage(m.marker.images.shadow),
    loadImage(m.marker.images.glow),
    loadImage(m.marker.images.body),
  ]);
  m.floors.forEach((f, i) => (f.img = floorImgs[i]));
  m.marker.layers = { shadow, glow, body };
  m.marker.canvas = document.createElement("canvas");
  state.mini = m;
  drawOverlay();
}

// ---------------- style presets ----------------

async function refreshPresets(presets) {
  presets ??= await api("/api/presets");
  state.presets = presets;
  const names = Object.keys(presets);
  for (const sel of $$(".presetSelect")) {
    const cur = sel.value;
    const first = sel.id === "newPreset" ? "기본 스타일" : "프리셋 선택…";
    sel.innerHTML = `<option value="">${first}</option>` + names.map((n) => `<option>${escapeHtml(n)}</option>`).join("");
    if (names.includes(cur)) sel.value = cur;
    else if (sel.id === "newPreset" && names.length) sel.value = names[names.length - 1];
  }
}

$("#presetApply").addEventListener("click", () => {
  const p = state.presets?.[$("#presetSelect").value];
  if (!p || !state.proj) return;
  Object.assign(state.proj.settings, p);
  fillSettings(state.proj.settings);
  saveSettings(true);
});
$("#presetSave").addEventListener("click", async () => {
  if (!state.proj) return;
  const name = prompt("프리셋 이름", $("#presetSelect").value || "내 채널 스타일");
  if (!name) return;
  await refreshPresets(await api("/api/presets", { method: "POST", body: JSON.stringify({ name, settings: state.proj.settings }) }));
  $("#presetSelect").value = name;
});
$("#presetDelete").addEventListener("click", async () => {
  const name = $("#presetSelect").value;
  if (!name || !confirm(`'${name}' 프리셋을 삭제할까요?`)) return;
  await refreshPresets(await api(`/api/presets/${encodeURIComponent(name)}`, { method: "DELETE" }));
});

// ---------------- rooms & events ----------------

let saveTimer;
function saveRoomsEvents() {
  state.events.sort((a, b) => a.t - b.t);
  renderRooms();
  renderEvents();
  drawPlan();
  drawTimeline();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 250);
}

async function doSave() {
  saveTimer = null;
  await api(`/api/projects/${state.proj.id}`, { method: "PUT", body: JSON.stringify({ rooms: state.rooms, events: state.events }) });
  await Promise.all([refreshTrack(), refreshMinimap()]);
}

async function flushSaves() {
  if (saveTimer) { clearTimeout(saveTimer); await doSave(); }
  if (editTimer) {
    clearTimeout(editTimer);
    editTimer = null;
    await api(`/api/projects/${state.proj.id}`, { method: "PUT", body: JSON.stringify({ floors: state.proj.floors }) });
  }
  if (settingsTimer) {
    clearTimeout(settingsTimer);
    settingsTimer = null;
    await api(`/api/projects/${state.proj.id}`, { method: "PUT", body: JSON.stringify({ settings: state.proj.settings }) });
  }
}

let trackSeq = 0;
async function refreshTrack() {
  const seq = ++trackSeq;
  const tr = await api(`/api/projects/${state.proj.id}/track?fps=30`);
  if (seq !== trackSeq) return;   // a newer request is already in flight; don't let a stale answer win
  state.track = tr;
  renderEvents();
  tick();
}

function recordRoom(room, t = video.currentTime) {
  t = +t.toFixed(3);
  const near = state.events.find((e) => Math.abs(e.t - t) < 0.3);
  if (near) near.room = room.id;
  else state.events.push({ t, room: room.id });
  saveRoomsEvents();
  flash(`${fmtTime(t)} → ${room.name || "방"}`);
}

function roomAt(t) {
  let cur = null;
  for (const e of state.events) { if (e.t <= t + 1e-3) cur = e; else break; }
  return roomById((cur || state.events[0])?.room);
}

function renderRooms() {
  const tb = $("#roomTable tbody");
  tb.innerHTML = state.rooms.map((r, i) => `
    <tr>
      <td><span class="swatch" style="background:${roomColor(r)}"></span> ${i < 9 ? i + 1 : ""}</td>
      <td><input data-room-name="${r.id}" value="${escapeHtml(r.name)}" /></td>
      <td>${escapeHtml(floorOf(r.floor)?.label || "")}</td>
      <td><button data-room-del="${r.id}" title="삭제">✕</button></td>
    </tr>`).join("") || `<tr><td colspan="4" class="muted">도면의 빈 곳을 클릭해서 방을 추가하세요</td></tr>`;

  const cur = roomAt(video.currentTime);
  $("#roomBar").innerHTML = state.rooms.map((r, i) =>
    `<button data-room-rec="${r.id}" class="${r === cur ? "current" : ""}">${i < 9 ? `<kbd>${i + 1}</kbd>` : ""}<span class="swatch" style="background:${roomColor(r)}"></span>${escapeHtml(r.name || "방")}</button>`
  ).join("");
}

$("#roomBar").addEventListener("click", (e) => {
  const b = e.target.closest("[data-room-rec]");
  if (b) recordRoom(roomById(b.dataset.roomRec));
});

$("#roomTable").addEventListener("change", (e) => {
  const inp = e.target.closest("[data-room-name]");
  if (!inp) return;
  roomById(inp.dataset.roomName).name = inp.value.trim();
  saveRoomsEvents();
});
$("#roomTable").addEventListener("click", (e) => {
  const b = e.target.closest("[data-room-del]");
  if (b) deleteRoom(roomById(b.dataset.roomDel));
});

function deleteRoom(room) {
  const n = state.events.filter((e) => e.room === room.id).length;
  if (n && !confirm(`'${room.name}' 방과 이동 기록 ${n}개를 삭제할까요?`)) return;
  state.rooms.splice(state.rooms.indexOf(room), 1);
  state.events = state.events.filter((e) => e.room !== room.id);
  saveRoomsEvents();
}

function renderEvents() {
  $("#evCount").textContent = `${state.events.length}개`;
  const opts = (sel) => state.rooms.map((r) => `<option value="${r.id}" ${r.id === sel ? "selected" : ""}>${escapeHtml(r.name || "방")} (${escapeHtml(floorOf(r.floor)?.label || "")})</option>`).join("");
  const active = activeEventIndex();
  $("#evTable tbody").innerHTML = state.events.map((e, i) => `
    <tr class="${i === active ? "active" : ""}">
      <td><a href="#" data-ev-seek="${i}">${fmtTime(e.t)}</a>${i === 0 ? " 🚩" : ""}${moveNote(e)}</td>
      <td><select data-ev-room="${i}">${opts(e.room)}</select>
        ${i > 0 ? `<select data-ev-mode="${i}" class="evmode" title="이 구간의 이동 방식">
          <option value="" ${!e.mode ? "selected" : ""}>기본 (${state.proj.settings.transition === "jump" ? "스르르" : "걸어서"})</option>
          <option value="walk" ${e.mode === "walk" ? "selected" : ""}>걸어서 이동</option>
          <option value="jump" ${e.mode === "jump" ? "selected" : ""}>스르르 전환</option></select>
        <label class="evsec" title="이 구간만 걸리는 시간(초). 비우면 전체 설정을 따릅니다">
          <input type="number" data-ev-sec="${i}" min="0" max="60" step="0.1" value="${e.sec ?? ""}" placeholder="${defaultSec(i)}" />초</label>` : ""}</td>
      <td>${i > 0 ? `<button data-ev-play="${i}" title="이 이동만 재생해서 확인 (앞뒤 1.5초)">▶ 이동 확인</button>` : ""}
        ${e.via?.length ? `<span class="evroute-row"><span class="muted">↩ 꺾임 ${e.via.length}</span><button data-ev-route-clear="${i}" class="evroute-clear" title="꺾은 점을 모두 지우고 직선으로 되돌립니다">초기화</button></span>` : ""}</td>
      <td><button data-ev-del="${i}" title="삭제">✕</button></td>
    </tr>`).join("") || `<tr><td colspan="3" class="muted">영상을 재생하며 숫자키를 누르거나 방을 클릭하세요</td></tr>`;
}

// ---------------- route bending (straight legs through points you set) ----------------
// A walk goes room -> via[0] -> via[1] -> ... -> room in straight lines. "via" lives on the event.

function canBend(i) {
  const e = state.events[i], prev = state.events[i - 1];
  if (!e || !prev || e.room === prev.room) return false;
  const a = roomById(prev.room), b = roomById(e.room);
  const mode = e.mode || (state.proj.settings.transition === "jump" ? "jump" : "walk");
  return !!(a && b && a.floor === b.floor && mode === "walk");
}

function routePoly(e) {
  const i = state.events.indexOf(e);
  const a = roomById(state.events[i - 1].room), b = roomById(e.room);
  return [[a.x, a.y], ...(e.via || []), [b.x, b.y]];
}

// the walks that can be bent on the floor being viewed
function bendableMoves() {
  return state.events.filter((e, i) => canBend(i) && roomById(e.room).floor === state.viewFloor);
}

// ---- undo for route bending: snapshots of every move's bend points, keyed by the record (time + room)
// so unrelated changes in between (a new record, a renamed room) are left alone ----

state.routeUndo = [];
const routeKey = (e) => `${e.t}|${e.room}`;

function pushRouteUndo() {
  state.routeUndo.push(state.events.map((e) => [routeKey(e), e.via ? JSON.stringify(e.via) : null]));
  if (state.routeUndo.length > 100) state.routeUndo.shift();
  $("#routeUndoBtn").disabled = false;
}

function undoRoute() {
  const last = state.routeUndo.pop();
  $("#routeUndoBtn").disabled = !state.routeUndo.length;
  if (!last) return;
  const snap = new Map(last);
  for (const e of state.events) {
    if (!snap.has(routeKey(e))) continue;
    const via = snap.get(routeKey(e));
    if (via) e.via = JSON.parse(via); else delete e.via;
  }
  saveRoomsEvents();
  flash("경로 되돌리기");
}
$("#routeUndoBtn").addEventListener("click", undoRoute);

function updatePlanHint() {
  $("#planHint").textContent = state.mode === "draw"
    ? "빨간 선 = 자동으로 인식된 벽·문·계단 (삭제·옮기기·뒤집기 가능) · 파란 선 = 직접 그린 것 · 잘못 잡힌 것은 삭제(X)나 지우개로, 빠진 것은 도구로 그리세요 · Ctrl+드래그 = 도형 옮기기 · Shift+드래그 = 끝점·모서리 크기 조절 · Ctrl+Shift+드래그 = 복사해서 옮기기"
    : state.mode === "route"
      ? "파란 선 = 이동 경로 · 선 근처 클릭 = 그 자리에 꺾는 점 추가 · 점 드래그 = 옮기기 · 점 우클릭 = 삭제 · 이동 기록 표의 초기화 = 바로 직선으로 · Ctrl+Z = 되돌리기"
      : "빈 곳 클릭 = 방 추가 · 방 클릭 = 현재 시각에 그 방으로 이동 기록 · 드래그 = 위치 수정 · 우클릭 = 방 삭제";
}

// nearest bend handle of any move on this floor: {ev, k} or null
function hitVia(p) {
  const tol = 12 * cssPx();
  let best = null, bd = tol;
  for (const ev of bendableMoves()) {
    (ev.via || []).forEach((q, k) => {
      const d = Math.hypot(q[0] - p.x, q[1] - p.y);
      if (d < bd) { bd = d; best = { ev, k }; }
    });
  }
  return best;
}

function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a[0]) * dx + (p.y - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p.x - (a[0] + t * dx), p.y - (a[1] + t * dy));
}

// a new bend goes into the leg (of any move on this floor) it is closest to, so you click near the line you mean
function insertVia(p) {
  let best = null, bd = Infinity;
  for (const ev of bendableMoves()) {
    const poly = routePoly(ev);
    for (let k = 0; k < poly.length - 1; k++) {
      const d = segDist(p, poly[k], poly[k + 1]);
      if (d < bd) { bd = d; best = { ev, k }; }
    }
  }
  if (!best) { flash("이 층에는 꺾을 수 있는 이동이 없습니다"); return false; }
  (best.ev.via ||= []).splice(best.k, 0, [+p.x.toFixed(1), +p.y.toFixed(1)]);
  return true;
}

// what the settings would give this move, shown as the placeholder of the per-move seconds box
function defaultSec(i) {
  const e = state.events[i], s = state.proj.settings;
  const mode = e.mode || (s.transition === "jump" ? "jump" : "walk");
  if (mode === "jump") return (+s.fade_sec).toFixed(1);
  if (s.move_timing === "time") return (+s.transition_sec).toFixed(1);
  const m = state.track?.moves?.find((x) => Math.abs(x.t - e.t) < 0.01);
  return m && e.sec == null && m.end > m.start ? (m.end - m.start).toFixed(1) : "자동";
}

// "2.1초 이동" under a record, with a warning when the walk had to wait for the previous one or runs past the video
function moveNote(e) {
  const m = state.track?.moves?.find((x) => Math.abs(x.t - e.t) < 0.01);
  if (!m || m.end <= m.start) return "";
  const dur = (m.end - m.start).toFixed(1);
  if (m.kind === "fade") return `<div class="mv">스르르 전환 ${dur}초</div>`;
  const late = m.delay > 0.05 || m.end > state.proj.video.duration + 0.01;
  const why = m.end > state.proj.video.duration + 0.01 ? "영상이 끝나기 전에 도착하지 못합니다"
    : `앞 이동이 끝나지 않아 ${m.delay.toFixed(1)}초 늦게 출발합니다`;
  return late
    ? `<div class="mv warn" title="${why}. 이동 속도를 빠르게 하거나 기록 간격을 넓히세요">⚠ ${dur}초 이동 · ${why}</div>`
    : `<div class="mv">${dur}초 이동</div>`;
}

function activeEventIndex() {
  let idx = -1;
  state.events.forEach((e, i) => { if (e.t <= video.currentTime + 1e-3) idx = i; });
  return idx;
}

$("#evTable").addEventListener("click", (e) => {
  const s = e.target.closest("[data-ev-seek]");
  if (s) { e.preventDefault(); video.pause(); video.currentTime = state.events[+s.dataset.evSeek].t; }
  const pl = e.target.closest("[data-ev-play]");
  if (pl) playAround(state.events[+pl.dataset.evPlay].t);
  const rc = e.target.closest("[data-ev-route-clear]");
  if (rc) {   // straight away, no confirmation: Ctrl+Z (or ↶ in ② 경로 꺾기) brings the bends back
    const ev = state.events[+rc.dataset.evRouteClear];
    if (ev.via?.length) { pushRouteUndo(); delete ev.via; saveRoomsEvents(); flash("경로 초기화 · Ctrl+Z로 되돌리기"); }
  }
  const d = e.target.closest("[data-ev-del]");
  if (d) { state.events.splice(+d.dataset.evDel, 1); saveRoomsEvents(); }
});
$("#evTable").addEventListener("change", (e) => {
  const s = e.target.closest("[data-ev-room]");
  if (s) { state.events[+s.dataset.evRoom].room = s.value; saveRoomsEvents(); }
  const md = e.target.closest("[data-ev-mode]");
  if (md) {
    const ev = state.events[+md.dataset.evMode];
    if (md.value) ev.mode = md.value; else delete ev.mode;
    saveRoomsEvents();
  }
  const sc = e.target.closest("[data-ev-sec]");
  if (sc) {
    const ev = state.events[+sc.dataset.evSec];
    const v = parseFloat(sc.value);
    if (sc.value !== "" && Number.isFinite(v) && v >= 0) ev.sec = Math.min(60, v); else delete ev.sec;
    saveRoomsEvents();
  }
});

// ---------------- plan editor ----------------

const viewImg = () => state.planImgs[state.viewFloor];
function planScale() { return planCv.width / viewImg().width; }

function planPoint(e) {
  const r = planCv.getBoundingClientRect();
  const img = viewImg();
  const k = img.width / r.width;
  // a drag that leaves the canvas (pointer capture keeps it alive) stays inside the plan image
  return { x: Math.max(0, Math.min(img.width, (e.clientX - r.left) * k)), y: Math.max(0, Math.min(img.height, (e.clientY - r.top) * k)) };
}

function hitRoom(p) {
  const r = planCv.getBoundingClientRect();
  const tol = 14 * (viewImg().width / r.width);
  let best = null, bd = tol;
  for (const room of state.rooms) {
    if (room.floor !== state.viewFloor) continue;
    const d = Math.hypot(room.x - p.x, room.y - p.y);
    if (d < bd) { bd = d; best = room; }
  }
  return best;
}

planCv.addEventListener("pointerdown", (e) => {
  if (!state.proj || e.button !== 0 || !viewImg()) return;
  if (state.mode === "draw") return drawDown(e);
  const p = planPoint(e);
  if (state.mode === "route") {
    const h = hitVia(p);
    if (h) {
      planCv.setPointerCapture(e.pointerId);
      pushRouteUndo();   // dropped again on pointerup if the point did not move
      state.drag = { via: h.k, ev: h.ev, start: p, moved: false };
      return;
    }
    if (hitRoom(p)) return;   // a room point is never a bend
    pushRouteUndo();
    if (insertVia(p)) saveRoomsEvents(); else state.routeUndo.pop();
    return;
  }
  const hit = hitRoom(p);
  if (hit) {
    planCv.setPointerCapture(e.pointerId);
    state.drag = { room: hit, start: p, moved: false };
    return;
  }
  openRoomDialog(p);
});

// ---- "방 추가" dialog: a name box plus example names that fill it when clicked ----

let pendingRoomPoint = null;
function openRoomDialog(p) {
  pendingRoomPoint = p;
  const inp = $("#roomNameInput");
  inp.value = suggestRoomName();
  $("#roomChips").innerHTML = ROOM_NAME_EXAMPLES.map((n) =>
    `<button type="button" data-chip="${escapeHtml(n)}" class="${state.rooms.some((r) => r.name === n) ? "used" : ""}">${escapeHtml(n)}</button>`).join("");
  $("#roomDialog").showModal();
  inp.focus();
  inp.select();
}
$("#roomChips").addEventListener("click", (e) => {
  const b = e.target.closest("[data-chip]");
  if (!b) return;
  const inp = $("#roomNameInput");
  inp.value = b.dataset.chip;
  inp.focus();
  inp.setSelectionRange(inp.value.length, inp.value.length);
});
$("#roomForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const p = pendingRoomPoint;
  pendingRoomPoint = null;
  $("#roomDialog").close();
  if (!p || !state.proj) return;
  addRoom($("#roomNameInput").value.trim(), p);
});
$("#roomDialog").addEventListener("close", () => { pendingRoomPoint = null; });

function addRoom(name, p) {
  const room = { id: "r" + Math.random().toString(36).slice(2, 8), name, floor: state.viewFloor, x: p.x, y: p.y };
  state.rooms.push(room);
  if (!state.events.length) state.events.push({ t: 0, room: room.id }); // first room = starting room
  saveRoomsEvents();
  return room;
}

planCv.addEventListener("pointermove", (e) => {
  if (state.mode === "draw") return drawMove(e);
  const d = state.drag;
  if (!d) return;
  const p = planPoint(e);
  if (!d.moved && Math.hypot(p.x - d.start.x, p.y - d.start.y) < 4 * cssPx()) return;
  d.moved = true;
  if (d.via != null) d.ev.via[d.via] = [+p.x.toFixed(1), +p.y.toFixed(1)];
  else { d.room.x = p.x; d.room.y = p.y; }
  drawPlan();
});

planCv.addEventListener("pointerup", (e) => {
  if (state.mode === "draw") return drawUp(e);
  const d = state.drag;
  state.drag = null;
  if (!d) return;
  if (d.via != null) { if (d.moved) saveRoomsEvents(); else state.routeUndo.pop(); return; }
  if (d.moved) saveRoomsEvents();
  else recordRoom(d.room);
});

planCv.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (state.mode === "draw") return;
  if (state.mode === "route") {
    const h = hitVia(planPoint(e));
    if (h) { pushRouteUndo(); h.ev.via.splice(h.k, 1); if (!h.ev.via.length) delete h.ev.via; saveRoomsEvents(); }
    return;
  }
  const hit = hitRoom(planPoint(e));
  if (hit) deleteRoom(hit);
});

const ROOM_NAME_EXAMPLES = ["Living Room", "Kitchen", "Room", "Bathroom", "Terrace"];

function suggestRoomName() {
  return ROOM_NAME_EXAMPLES.find((n) => !state.rooms.some((r) => r.name === n)) || "";
}

// one CSS pixel, in plan units
const cssPx = () => viewImg().width / planCv.getBoundingClientRect().width;

// ---------------- plan drawing tools ("도면 다듬기") ----------------
// Edits live on each floor as floor.edits = [{type: line|door|stairs|erase, ...}] in plan pixels.
// The server combines them with the automatically detected walls when it draws the minimap.

state.mode = "rooms";
state.tool = "line";
state.structImgs = {};
state.undo = [];

const curEdits = () => {
  const f = floorOf(state.viewFloor);
  f.edits ??= [];
  return f.edits;
};

for (const b of $$("[data-mode]")) b.addEventListener("click", () => setMode(b.dataset.mode));
for (const b of $$("[data-tool]")) b.addEventListener("click", () => setTool(b.dataset.tool));
$("#undoBtn").addEventListener("click", undoEdit);
$("#showOriginal").addEventListener("change", drawPlan);

function setMode(mode) {
  state.mode = mode;
  for (const b of $$("[data-mode]")) b.classList.toggle("active", b.dataset.mode === mode);
  $("#drawBar").classList.toggle("hidden", mode !== "draw");
  $("#routeBar").classList.toggle("hidden", mode !== "route");
  $("#routeUndoBtn").disabled = !state.routeUndo.length;
  updatePlanHint();
  planCv.style.cursor = mode === "rooms" ? "" : "crosshair";
  if (mode === "draw") loadStruct();
  drawPlan();
}

function setTool(tool) {
  state.tool = tool;
  for (const b of $$("[data-tool]")) b.classList.toggle("active", b.dataset.tool === tool);
  if (state.mode === "draw") drawPlan();   // the delete tool reveals eraser strokes, the eraser its cursor
}

async function loadStruct() {
  if (!state.proj) return;
  const fid = state.viewFloor;
  state.structImgs[fid] = await loadImage(`/api/projects/${state.proj.id}/structure/${fid}.png?v=${Date.now()}`);
  drawPlan();
}

// ---------------- automatic detection (walls / thin lines / doors / stairs) ----------------
// Runs on upload; "다시 인식" replaces only the automatic items of the floor being viewed.

$("#autoDetectBtn").addEventListener("click", () => redetect(false));
$("#autoClearBtn").addEventListener("click", () => redetect(true));

async function redetect(clear) {
  if (!state.proj) return;
  const f = floorOf(state.viewFloor);
  const n = (f.edits || []).filter((e) => e.auto).length;
  if (clear && n && !confirm(`${f.label}의 자동 인식 항목 ${n}개를 지울까요? 직접 그린 것과 지우개 자국은 남습니다.`)) return;
  const s = state.proj.settings;
  const kinds = clear ? [] : ["walls", "thin", "doors", "stairs"].filter((k) => s["auto_" + k]);
  if (!clear && !kinds.length) { flash("인식할 항목을 하나 이상 선택하세요"); return; }
  const btn = $("#autoDetectBtn");
  btn.disabled = true;
  try {
    await flushSaves();
    pushUndo();
    const proj = await api(`/api/projects/${state.proj.id}/floors/${f.id}/auto`, { method: "POST", body: JSON.stringify({ kinds }) });
    f.edits = proj.floors.find((x) => x.id === f.id)?.edits || [];
    flash(clear ? "자동 인식 항목 삭제" : `자동 인식 ${f.edits.filter((e) => e.auto).length}개 (Ctrl+Z로 되돌리기)`);
    drawPlan();
    await Promise.all([refreshMinimap(), refreshTrack(), loadStruct()]);
  } catch (err) {
    alert("자동 인식 실패: " + err.message);
  } finally {
    btn.disabled = false;
  }
}

function pushUndo() {
  state.undo.push({ fid: state.viewFloor, edits: JSON.stringify(curEdits()) });
  if (state.undo.length > 100) state.undo.shift();
}

function undoEdit() {
  const last = state.undo.pop();
  if (!last) return;
  floorOf(last.fid).edits = JSON.parse(last.edits);
  saveEdits(true);
}

let editTimer;
function saveEdits(erased = false) {
  drawPlan();
  clearTimeout(editTimer);
  editTimer = setTimeout(async () => {
    editTimer = null;
    await api(`/api/projects/${state.proj.id}`, { method: "PUT", body: JSON.stringify({ floors: state.proj.floors }) });
    // walls changed -> routes change too
    await Promise.all([refreshMinimap(), refreshTrack(), erased ? loadStruct() : null]);
  }, 300);
}

function snapPoint(p, from, free, skip = null) {
  // snap to existing endpoints first, then keep lines horizontal / vertical
  const tol = 9 * cssPx();
  for (const e of curEdits()) {
    if (e === skip) continue;
    const ends = e.type === "line" ? [e.pts[0], e.pts[e.pts.length - 1]] : e.type === "door" ? [e.hinge, e.end] : [];
    for (const q of ends) if (Math.hypot(q[0] - p.x, q[1] - p.y) < tol) return { x: q[0], y: q[1] };
  }
  if (from && !free) {
    const dx = p.x - from.x, dy = p.y - from.y;
    const ang = Math.abs(Math.atan2(dy, dx) * 180 / Math.PI);
    if (ang < 10 || ang > 170) return { x: p.x, y: from.y };
    if (Math.abs(ang - 90) < 10) return { x: from.x, y: p.y };
  }
  return p;
}

// crossing point of segments p-q and a-b (a and b as [x, y]), or null when they don't cross
function segCross(p, q, a, b) {
  const rx = q.x - p.x, ry = q.y - p.y, sx = b[0] - a[0], sy = b[1] - a[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((a[0] - p.x) * sy - (a[1] - p.y) * sx) / den;
  const u = ((a[0] - p.x) * ry - (a[1] - p.y) * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: p.x + t * rx, y: p.y + t * ry };
}

// A line drawn to a wall stops exactly on it: an end that runs a little past the wall (or falls a
// little short of it) is moved onto the crossing, so nothing pokes out of the plan's outline.
function clipToWalls(start, end) {
  const tol = 12 * cssPx();
  const len = Math.hypot(end.x - start.x, end.y - start.y);
  if (len < 1e-6) return [start, end];
  const ux = (end.x - start.x) / len, uy = (end.y - start.y) / len;
  const walls = curEdits().filter((e) => e.type === "line").flatMap(editSegments);
  // the plan's outline: an end outside it always comes back to the outer wall it crossed
  const xs = walls.flatMap(([a, b]) => [a[0], b[0]]), ys = walls.flatMap(([a, b]) => [a[1], b[1]]);
  const outside = (q) => xs.length && (q.x < Math.min(...xs) || q.x > Math.max(...xs) || q.y < Math.min(...ys) || q.y > Math.max(...ys));
  const clip = (from, to, dir) => {   // `to` slides along the line onto the nearest wall crossing within tol
    const far = { x: to.x + dir * ux * tol, y: to.y + dir * uy * tol };
    let best = null, bd = outside(to) ? Infinity : tol;
    for (const [a, b] of walls) {
      const q = segCross(from, far, a, b);
      if (!q) continue;
      const d = Math.hypot(q.x - to.x, q.y - to.y);
      if (d < bd && Math.hypot(q.x - from.x, q.y - from.y) > tol) { bd = d; best = q; }
    }
    return best || to;
  };
  const e2 = clip(start, end, 1);
  const s2 = clip(e2, start, -1);
  return [s2, e2];
}

// Ctrl (or ⌘) + drag moves any drawn item as a whole
function translateEdit(e, dx, dy) {
  const mv = (q) => [q[0] + dx, q[1] + dy];
  if (e.pts) e.pts = e.pts.map(mv);
  if (e.hinge) { e.hinge = mv(e.hinge); e.end = mv(e.end); }
  if (e.a) { e.a = mv(e.a); e.b = mv(e.b); }
  if (e.c) e.c = mv(e.c);
}

function moveCursor(e, p) {
  if (state.drawing) return;
  const over = p && hitEdit(p, null, true);
  if (p && resizeGesture(e)) {   // resize: a handle under the pointer, or the nearest handle of the shape under it
    planCv.style.cursor = hitHandle(p) || hitEdit(p, SHAPE_TYPES, true) ? "nwse-resize" : "crosshair";
    return;
  }
  planCv.style.cursor = state.tool === "copy" ? (over ? "copy" : "crosshair")
    : (e.ctrlKey || e.metaKey) && over ? "grab" : "crosshair";
}

// ---- resize: drag an endpoint / corner / side of a drawn item (resize tool, or Shift+drag with any tool) ----

const SHAPE_TYPES = ["line", "door", "stairs", "toilet", "rect", "circle", "basin", "sink", "induction", "closet"];
const resizeGesture = (e) => state.tool === "resize" || (e.shiftKey && !e.ctrlKey && !e.metaKey);

// handles of a drawn item: [{pt, set(p, alt)}]. The geometry is captured when the handles are made
// (at the start of a drag), so a corner dragged past the opposite one simply turns the box inside out.
function editHandles(e) {
  const H = [];
  const P = (q) => ({ x: q[0], y: q[1] });
  if (e.type === "line") {
    e.pts.forEach((q, i) => H.push({ pt: q, set: (p, alt) => {
      const other = e.pts.length === 2 ? P(e.pts[1 - i]) : null;   // a two-point line stays horizontal / vertical
      const s = snapPoint(p, other, alt || !other, e);
      e.pts[i] = [s.x, s.y];
    } }));
  } else if (e.type === "door") {
    for (const [k, other] of [["hinge", "end"], ["end", "hinge"]]) {
      H.push({ pt: e[k], set: (p, alt) => { const s = snapPoint(p, P(e[other]), alt, e); e[k] = [s.x, s.y]; } });
    }
  } else if (e.type === "toilet") {
    for (const k of ["a", "b"]) H.push({ pt: e[k], set: (p) => { e[k] = [p.x, p.y]; } });
  } else if (e.type === "circle") {
    for (const t of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
      H.push({ pt: [e.c[0] + e.r * Math.cos(t), e.c[1] + e.r * Math.sin(t)],
        set: (p) => { e.r = Math.max(1, Math.hypot(p.x - e.c[0], p.y - e.c[1])); } });
    }
  } else if (e.type === "rect" || e.type === "stairs" || FIXTURES.includes(e.type)) {
    const box = [Math.min(e.a[0], e.b[0]), Math.min(e.a[1], e.b[1]), Math.max(e.a[0], e.b[0]), Math.max(e.a[1], e.b[1])];
    const setBox = (b) => { e.a = [Math.min(b[0], b[2]), Math.min(b[1], b[3])]; e.b = [Math.max(b[0], b[2]), Math.max(b[1], b[3])]; };
    for (const [ix, iy] of [[0, 1], [2, 1], [2, 3], [0, 3]]) {   // corners
      H.push({ pt: [box[ix], box[iy]], set: (p) => { const s = snapPoint(p, null, true, e); const b = [...box]; b[ix] = s.x; b[iy] = s.y; setBox(b); } });
    }
    for (const [i, pt] of [[1, [(box[0] + box[2]) / 2, box[1]]], [2, [box[2], (box[1] + box[3]) / 2]],
                           [3, [(box[0] + box[2]) / 2, box[3]]], [0, [box[0], (box[1] + box[3]) / 2]]]) {   // sides
      H.push({ pt, set: (p) => { const b = [...box]; b[i] = i % 2 ? p.y : p.x; setBox(b); } });
    }
  }
  return H;
}

// the handle under the pointer, of any item on this floor: {e, h} or null
function hitHandle(p, tol = 10 * cssPx()) {
  let best = null, bd = tol;
  for (const e of curEdits()) {
    if (!SHAPE_TYPES.includes(e.type)) continue;
    for (const h of editHandles(e)) {
      const d = Math.hypot(h.pt[0] - p.x, h.pt[1] - p.y);
      if (d < bd) { bd = d; best = { e, h }; }
    }
  }
  return best;
}

// a handle to drag from point p: the one under the pointer, else the nearest handle of the item under it
function resizeTarget(p) {
  const hh = hitHandle(p);
  if (hh) return hh;
  const e = hitEdit(p, SHAPE_TYPES, true);
  if (!e) return null;
  let best = null, bd = Infinity;
  for (const h of editHandles(e)) {
    const d = Math.hypot(h.pt[0] - p.x, h.pt[1] - p.y);
    if (d < bd) { bd = d; best = h; }
  }
  return best && { e, h: best };
}

function startResize(p, target) {
  pushUndo();
  state.drawing = { type: "resize", target: target.e, handle: target.h, moved: false };
  planCv.style.cursor = "nwse-resize";
}

function drawHandles(ctx, e, u, active = null) {
  const s = 3.5 * u;
  ctx.lineWidth = 1.5 * u;
  for (const h of editHandles(e)) {
    const on = active && h.pt[0] === active.pt[0] && h.pt[1] === active.pt[1];
    ctx.fillStyle = on ? "#2563eb" : "#fff";
    ctx.strokeStyle = "#2563eb";
    ctx.beginPath();
    ctx.rect(h.pt[0] - s, h.pt[1] - s, 2 * s, 2 * s);
    ctx.fill();
    ctx.stroke();
  }
}

// a copy of a drawn item, added to the floor; copies count as hand-drawn even when the original was automatic
function duplicateEdit(e) {
  const c = JSON.parse(JSON.stringify(e));
  delete c.auto;
  curEdits().push(c);
  return c;
}

// start dragging `target` (a fresh copy when `copy` is set); a click without movement just offsets the copy
function startMove(p, target, copy) {
  pushUndo();
  state.drawing = { type: "move", target: copy ? duplicateEdit(target) : target, last: p, moved: false, copy };
  planCv.style.cursor = "grabbing";
}

function drawDown(e) {
  const p = planPoint(e);
  planCv.setPointerCapture(e.pointerId);
  const t = state.tool;
  if (e.ctrlKey || e.metaKey) {   // Ctrl+drag moves, Ctrl+Shift+drag drags a copy
    const hit = hitEdit(p, null, true);
    if (hit) startMove(p, hit, e.shiftKey);
    return;
  }
  if (resizeGesture(e)) {   // resize tool, or Shift+drag with any tool
    const target = resizeTarget(p);
    if (target) { startResize(p, target); return; }
    if (t === "resize") return;   // Shift over empty space with another tool: draw as usual
  }
  if (t === "copy") {
    const hit = hitEdit(p, null, true);
    if (hit) startMove(p, hit, true);
    return;
  }
  if (t === "delete") {
    const hit = hitEdit(p);
    if (hit) { pushUndo(); curEdits().splice(curEdits().indexOf(hit), 1); saveEdits(hit.type === "erase"); }
    return;
  }
  // clicking an existing door / toilet / stairs with its own tool (or the flip tool) flips it
  if (FLIPPABLE.includes(t) || t === "flip") {
    const hit = hitEdit(p, t === "flip" ? FLIPPABLE : [t], true);
    if (hit) { state.drawing = { type: "flip", target: hit, start: p }; return; }
    if (t === "flip") return;
  }
  const s = t === "erase" ? p : snapPoint(p, null, e.altKey);
  const r = (+$("#eraseSize").value) * cssPx();
  state.drawing = t === "erase" ? { type: "erase", pts: [[s.x, s.y]], r }
    : { type: t, start: s, end: s, start0: s };
  drawPlan();
}

function drawMove(e) {
  const d = state.drawing;
  const p = planPoint(e);
  state.hover = p;
  if (!d) { moveCursor(e, p); if (state.tool === "erase" || resizeGesture(e)) drawPlan(); return; }
  if (d.type === "resize") {
    d.handle.set(p, e.altKey);
    d.moved = true;
    drawPlan();
    return;
  }
  if (d.type === "move") {
    translateEdit(d.target, p.x - d.last.x, p.y - d.last.y);
    d.last = p;
    d.moved = true;
    drawPlan();
    return;
  }
  if (d.type === "flip" && state.tool !== "flip" && Math.hypot(p.x - d.start.x, p.y - d.start.y) > 4 * cssPx()) {
    // pressed on an existing door / stairs / toilet but dragging: draw a new one from there (a flight of
    // stairs often continues from the edge of the previous one); only a plain click flips
    d.type = state.tool;
    d.start = d.start0 = snapPoint(d.start, null, e.altKey);
    d.end = p;
    delete d.target;
  }
  if (d.type === "erase") d.pts.push([p.x, p.y]);
  else if (d.type === "line" || d.type === "thinline") [d.start, d.end] = clipToWalls(d.start0, snapPoint(p, d.start0, e.altKey));
  else if (d.type !== "flip") d.end = p;
  drawPlan();
}

function drawUp() {
  const d = state.drawing;
  state.drawing = null;
  if (!d) return;
  if (d.type === "resize") {
    if (d.moved) saveEdits();
    else { state.undo.pop(); drawPlan(); }
    return;
  }
  if (d.type === "move") {
    planCv.style.cursor = state.tool === "copy" ? "copy" : "grab";
    if (d.moved) saveEdits(d.target.type === "erase");
    else if (d.copy) {   // a plain click: put the copy just beside the original so it is visible
      translateEdit(d.target, 12 * cssPx(), 12 * cssPx());
      saveEdits(d.target.type === "erase");
      flash("복사됨 · Ctrl+드래그로 옮기세요");
    } else { state.undo.pop(); drawPlan(); }
    return;
  }
  const len = d.start && d.end ? Math.hypot(d.end.x - d.start.x, d.end.y - d.start.y) : 0;
  const min = 4 * cssPx();
  pushUndo();
  if (d.type === "flip") flipEdit(d.target);
  else if (d.type === "erase") curEdits().push({ type: "erase", pts: d.pts, r: d.r });
  else if (len < min) { state.undo.pop(); drawPlan(); return; }
  else if (d.type === "line") curEdits().push({ type: "line", pts: [[d.start.x, d.start.y], [d.end.x, d.end.y]] });
  else if (d.type === "door") curEdits().push({ type: "door", hinge: [d.start.x, d.start.y], end: [d.end.x, d.end.y], flip: false });
  else if (d.type === "stairs") curEdits().push({ type: "stairs", a: [d.start.x, d.start.y], b: [d.end.x, d.end.y] });
  else if (d.type === "thinline") curEdits().push({ type: "line", pts: [[d.start.x, d.start.y], [d.end.x, d.end.y]], thin: true });
  else curEdits().push({ ...previewShape(d), thin: $("#shapesThin").checked });  // toilet / rect / circle / fixtures
  saveEdits(d.type === "erase");
}

function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p.x - a[0]) * dx + (p.y - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p.x - (a[0] + t * dx), p.y - (a[1] + t * dy));
}

const FLIPPABLE = ["door", "toilet", "stairs"];
const FIXTURES = ["basin", "sink", "induction", "closet"];   // box symbols drawn from corner a to corner b
const TOILET_ELONGATION = 2.6;   // depth / half width ("D" shape, same as the renderer)

function flipEdit(e) {
  if (e.type === "door") e.flip = !e.flip;                                   // swing direction
  else if (e.type === "toilet") e.b = [2 * e.a[0] - e.b[0], 2 * e.a[1] - e.b[1]];   // bowl to the other side of the wall
  else if (e.type === "stairs") e.flip = !e.flip;                           // direction of the step lines
}

// in-progress drag -> the edit it would create
function previewShape(d) {
  const a = [d.start.x, d.start.y], b = [d.end.x, d.end.y];
  if (d.type === "line" || d.type === "thinline") return { type: "line", pts: [a, b], thin: d.type === "thinline" };
  if (d.type === "door") return { type: "door", hinge: a, end: b };
  if (d.type === "circle") return { type: "circle", c: a, r: Math.hypot(b[0] - a[0], b[1] - a[1]) };
  return { type: d.type, a, b };  // stairs / rect / toilet
}

// outline of a shape as a closed polygon (for hit testing)
function ring(cx, cy, r, a0, a1, n = 24) {
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = a0 + (a1 - a0) * i / n;
    return [cx + r * Math.cos(t), cy + r * Math.sin(t)];
  });
}

// "D" outline: flat side at a, straight sides, semicircular front reaching b (plan coords)
function toiletGeom(e) {
  const [ax, ay] = e.a, [bx, by] = e.b;
  const depth = Math.hypot(bx - ax, by - ay) || 1, w = depth / TOILET_ELONGATION;
  const ux = (bx - ax) / depth, uy = (by - ay) / depth, nx = -uy, ny = ux;
  return { ax, ay, w, ux, uy, nx, ny, cx: ax + ux * (depth - w), cy: ay + uy * (depth - w), ang: Math.atan2(uy, ux) };
}

function toiletOutline(e, n = 16) {
  const g = toiletGeom(e);
  const pts = [[g.ax + g.nx * g.w, g.ay + g.ny * g.w]];
  for (let i = 0; i <= n; i++) {              // front arc from the +n side round to the -n side
    const t = g.ang + Math.PI / 2 - Math.PI * i / n;
    pts.push([g.cx + g.w * Math.cos(t), g.cy + g.w * Math.sin(t)]);
  }
  pts.push([g.ax - g.nx * g.w, g.ay - g.ny * g.w]);
  return pts;
}

const polySegments = (pts, closed) => {
  const segs = pts.slice(1).map((q, i) => [pts[i], q]);
  if (closed) segs.push([pts[pts.length - 1], pts[0]]);
  return segs;
};

function editSegments(e) {
  if (e.type === "rect" || FIXTURES.includes(e.type)) {
    const [x0, y0] = e.a, [x1, y1] = e.b;
    return polySegments([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], true);
  }
  if (e.type === "circle") return polySegments(ring(e.c[0], e.c[1], e.r, 0, Math.PI * 2), false);
  if (e.type === "toilet") return polySegments(toiletOutline(e), true);
  if (e.type === "line" || e.type === "erase") return e.pts.length === 1 ? [[e.pts[0], e.pts[0]]] : e.pts.slice(1).map((q, i) => [e.pts[i], q]);
  if (e.type === "door") return [[e.hinge, e.end]];
  if (e.type === "stairs") {
    const [x0, y0] = e.a, [x1, y1] = e.b;
    return [[[x0, y0], [x1, y0]], [[x1, y0], [x1, y1]], [[x1, y1], [x0, y1]], [[x0, y1], [x0, y0]]];
  }
  return [];
}

// point inside a closed shape (stairs / rect box, toilet half-ellipse)?
function insideEdit(e, p) {
  if (e.type === "stairs" || e.type === "rect" || FIXTURES.includes(e.type)) {
    return p.x >= Math.min(e.a[0], e.b[0]) && p.x <= Math.max(e.a[0], e.b[0]) && p.y >= Math.min(e.a[1], e.b[1]) && p.y <= Math.max(e.a[1], e.b[1]);
  }
  if (e.type === "toilet") {
    const poly = toiletOutline(e);
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if (yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  return false;
}

function hitEdit(p, types, interior = false) {
  let best = null, bd = 8 * cssPx();
  for (const e of curEdits()) {
    if (types && !types.includes(e.type)) continue;
    let d = Math.min(...editSegments(e).map(([a, b]) => segDist(p, a, b)));
    if (interior && insideEdit(e, p)) d = 0;
    if (e.type === "erase") d -= e.r;
    if (e.type === "door") {
      const r = Math.hypot(e.end[0] - e.hinge[0], e.end[1] - e.hinge[1]);
      d = Math.min(d, Math.abs(Math.hypot(p.x - e.hinge[0], p.y - e.hinge[1]) - r));
    }
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

function drawEditShape(ctx, e) {
  ctx.beginPath();
  if (e.type === "line") {
    e.pts.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])));
  } else if (e.type === "door") {
    const [hx, hy] = e.hinge, [ex, ey] = e.end;
    const r = Math.hypot(ex - hx, ey - hy), a0 = Math.atan2(ey - hy, ex - hx);
    ctx.moveTo(hx, hy);
    ctx.lineTo(ex, ey);
    ctx.moveTo(ex, ey);
    ctx.arc(hx, hy, r, a0, a0 + (e.flip ? -1 : 1) * Math.PI / 2, !!e.flip);
  } else if (e.type === "rect") {
    ctx.rect(Math.min(e.a[0], e.b[0]), Math.min(e.a[1], e.b[1]), Math.abs(e.b[0] - e.a[0]), Math.abs(e.b[1] - e.a[1]));
  } else if (e.type === "circle") {
    ctx.arc(e.c[0], e.c[1], e.r, 0, Math.PI * 2);
  } else if (e.type === "toilet") {
    const g = toiletGeom(e);
    ctx.moveTo(g.ax + g.nx * g.w, g.ay + g.ny * g.w);
    ctx.lineTo(g.cx + g.nx * g.w, g.cy + g.ny * g.w);
    ctx.arc(g.cx, g.cy, g.w, g.ang + Math.PI / 2, g.ang - Math.PI / 2, true);
    ctx.lineTo(g.ax - g.nx * g.w, g.ay - g.ny * g.w);
    ctx.closePath();
  } else if (FIXTURES.includes(e.type)) {
    drawFixture(ctx, e);
  } else if (e.type === "stairs") {
    const x0 = Math.min(e.a[0], e.b[0]), x1 = Math.max(e.a[0], e.b[0]);
    const y0 = Math.min(e.a[1], e.b[1]), y1 = Math.max(e.a[1], e.b[1]);
    const w = x1 - x0, h = y1 - y0;
    const n = e.steps || Math.min(18, Math.max(4, Math.round(Math.max(w, h) / (Math.min(w, h) * 0.45 + 1e-6))));
    const across = (h >= w) !== !!e.flip;
    ctx.rect(x0, y0, w, h);
    for (let i = 1; i < n; i++) {
      if (across) { ctx.moveTo(x0, y0 + h * i / n); ctx.lineTo(x1, y0 + h * i / n); }
      else { ctx.moveTo(x0 + w * i / n, y0); ctx.lineTo(x0 + w * i / n, y1); }
    }
  }
  ctx.stroke();
}

// the same simple symbols the renderer draws (see draw_edits in app/render.py)
function drawFixture(ctx, e) {
  const x0 = Math.min(e.a[0], e.b[0]), x1 = Math.max(e.a[0], e.b[0]);
  const y0 = Math.min(e.a[1], e.b[1]), y1 = Math.max(e.a[1], e.b[1]);
  const w = x1 - x0, h = y1 - y0, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  ctx.rect(x0, y0, w, h);
  if (e.type === "basin") {
    ctx.moveTo(cx + w * 0.34, cy);
    ctx.ellipse(cx, cy, w * 0.34, h * 0.34, 0, 0, Math.PI * 2);
  } else if (e.type === "sink") {
    ctx.rect(x0 + w * 0.18, y0 + h * 0.18, w * 0.64, h * 0.64);
  } else if (e.type === "induction") {
    let centres, r;
    if (w / (h || 1e-6) >= 0.6 && w / (h || 1e-6) <= 1.6) {
      centres = [0.3, 0.7].flatMap((fx) => [0.3, 0.7].map((fy) => [x0 + w * fx, y0 + h * fy]));
      r = Math.min(w, h) * 0.14;
    } else {
      const along = w >= h;
      centres = [0, 1, 2].map((i) => along ? [x0 + w * (i + 0.5) / 3, cy] : [cx, y0 + h * (i + 0.5) / 3]);
      r = Math.min(w, h) * 0.28;
    }
    for (const [x, y] of centres) { ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, Math.PI * 2); }
  } else if (e.type === "closet") {
    const along = w >= h, short = Math.min(w, h), step = Math.max(short * 0.5, 1e-6), tick = short * 0.22;
    const n = Math.min(30, Math.floor(Math.max(w, h) / step));
    if (along) {
      ctx.moveTo(x0, cy); ctx.lineTo(x1, cy);
      for (let i = 1; i < n; i++) { ctx.moveTo(x0 + i * step, cy - tick); ctx.lineTo(x0 + i * step, cy + tick); }
    } else {
      ctx.moveTo(cx, y0); ctx.lineTo(cx, y1);
      for (let i = 1; i < n; i++) { ctx.moveTo(cx - tick, y0 + i * step); ctx.lineTo(cx + tick, y0 + i * step); }
    }
  }
}

// eraser stroke as a path (a single click is a dot)
function erasePath(ctx, pts) {
  ctx.beginPath();
  pts.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])));
  if (pts.length === 1) ctx.lineTo(pts[0][0] + 0.01, pts[0][1]);
}

// The lines are drawn on their own layer in order, and every eraser stroke really wipes what was drawn
// before it (the automatic raster/vector lines and earlier hand-drawn items), just as the renderer does.
// The strokes themselves leave no trace; only the delete tool shows them faintly so one can be removed.
const inkLayer = document.createElement("canvas");

function drawEditsLayer(ctx, u) {
  const s = planScale();
  if (inkLayer.width !== planCv.width || inkLayer.height !== planCv.height) { inkLayer.width = planCv.width; inkLayer.height = planCv.height; }
  const g = inkLayer.getContext("2d");
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, inkLayer.width, inkLayer.height);
  g.globalCompositeOperation = "source-over";
  if (state.structImgs[state.viewFloor]) g.drawImage(state.structImgs[state.viewFloor], 0, 0, inkLayer.width, inkLayer.height);
  g.setTransform(s, 0, 0, s, 0, 0);
  g.lineCap = g.lineJoin = "round";
  const d = state.drawing;
  const wipe = (pts, r) => {
    g.globalCompositeOperation = "destination-out";
    g.lineWidth = r * 2;
    g.strokeStyle = "#000";
    erasePath(g, pts);
    g.stroke();
    g.globalCompositeOperation = "source-over";
  };
  for (const e of curEdits()) {
    if (e.type === "erase") {
      wipe(e.pts, e.r);
    } else {
      g.strokeStyle = e.auto ? "#dc2626" : "#2563eb";   // red = detected automatically, blue = drawn by hand
      g.lineWidth = (e.thin ? 1.3 : 2.5) * u;
      drawEditShape(g, e);
    }
  }
  if (d?.type === "erase") wipe(d.pts, d.r);            // the stroke being drawn erases live
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(inkLayer, 0, 0);
  ctx.restore();

  ctx.lineCap = ctx.lineJoin = "round";
  if (state.tool === "delete") {   // only here: where the eraser went, so a stroke can be picked and removed
    for (const e of curEdits()) {
      if (e.type !== "erase") continue;
      ctx.strokeStyle = "rgba(236,72,153,.22)";
      ctx.lineWidth = e.r * 2;
      erasePath(ctx, e.pts);
      ctx.stroke();
    }
  }
  // resize handles: on the item being resized, or the one under the pointer while the gesture is available
  if (d?.type === "resize") drawHandles(ctx, d.target, u, d.handle);
  else if (!d && state.hover && (state.tool === "resize" || state.shiftDown)) {
    const t = resizeTarget(state.hover);
    if (t) drawHandles(ctx, t.e, u, hitHandle(state.hover)?.h);
  }
  if (d && d.type !== "flip" && d.type !== "move" && d.type !== "resize") {
    if (d.type === "erase") {
      // nothing to draw: the ink layer above already shows the stroke wiping the lines
    } else {
      const shape = previewShape(d);
      const thin = d.type === "thinline" || (["toilet", "rect", "circle", ...FIXTURES].includes(d.type) && $("#shapesThin").checked);
      ctx.strokeStyle = "#16a34a";
      ctx.lineWidth = (thin ? 1.3 : 2.5) * u;
      drawEditShape(ctx, shape);
    }
  }
  if (state.tool === "erase" && state.hover && !d) {
    ctx.strokeStyle = "rgba(236,72,153,.8)";
    ctx.lineWidth = u;
    ctx.beginPath();
    ctx.arc(state.hover.x, state.hover.y, (+$("#eraseSize").value) * cssPx(), 0, Math.PI * 2);
    ctx.stroke();
  }
}

// the whole walking route of this floor, as the marker will travel it
function drawRoute(ctx, u) {
  const tr = state.track;
  if (!tr || !tr.x.length) return;
  const fi = state.proj.floors.findIndex((f) => f.id === state.viewFloor);
  ctx.save();
  ctx.strokeStyle = "rgba(17,17,17,.55)";
  ctx.lineWidth = 2 * u;
  ctx.setLineDash([5 * u, 4 * u]);
  ctx.lineJoin = ctx.lineCap = "round";
  ctx.beginPath();
  let pen = false;
  for (let i = 0; i < tr.x.length; i++) {
    if (tr.floor[i] !== fi) { pen = false; continue; }
    if (pen && tr.x[i] === tr.x[i - 1] && tr.y[i] === tr.y[i - 1]) continue;
    pen ? ctx.lineTo(tr.x[i], tr.y[i]) : ctx.moveTo(tr.x[i], tr.y[i]);
    pen = true;
  }
  ctx.stroke();
  ctx.restore();
}

function drawPlan() {
  const img = viewImg();
  if (!img) return;
  const ctx = planCv.getContext("2d");
  const s = planScale();
  const u = (window.devicePixelRatio || 1) / s; // one CSS pixel in plan units
  const drawing = state.mode === "draw";
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, planCv.width, planCv.height);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, planCv.width, planCv.height);
  if (!drawing || $("#showOriginal").checked) {
    ctx.globalAlpha = drawing ? 0.35 : 1;
    ctx.drawImage(img, 0, 0, planCv.width, planCv.height);
    ctx.globalAlpha = 1;
  }
  ctx.setTransform(s, 0, 0, s, 0, 0);   // in draw mode the detected raster lines go onto the ink layer (drawEditsLayer)

  if (drawing) {
    drawEditsLayer(ctx, u);
    // room names for orientation only
    ctx.font = `${11 * u}px sans-serif`;
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(0,0,0,.45)";
    for (const r of state.rooms) if (r.floor === state.viewFloor) ctx.fillText(r.name, r.x, r.y);
    return;
  }

  drawRoute(ctx, u);
  if (state.mode === "route") {
    for (const ev of bendableMoves()) {
      const poly = routePoly(ev);
      ctx.strokeStyle = "#2563eb";
      ctx.lineWidth = 3 * u;
      ctx.lineJoin = ctx.lineCap = "round";
      ctx.beginPath();
      poly.forEach((q, k) => (k ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])));
      ctx.stroke();
      for (const q of ev.via || []) {
        ctx.fillStyle = "#fff";
        ctx.strokeStyle = "#2563eb";
        ctx.lineWidth = 2.5 * u;
        ctx.beginPath();
        ctx.arc(q[0], q[1], 6 * u, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
  }

  const cur = roomAt(video.currentTime);
  state.rooms.forEach((r, i) => {
    if (r.floor !== state.viewFloor) return;
    const col = roomColor(r);
    ctx.fillStyle = col;
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2 * u;
    ctx.beginPath();
    ctx.arc(r.x, r.y, (r === cur ? 11 : 9) * u, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.font = `bold ${11 * u}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(i < 9 ? String(i + 1) : "", r.x, r.y + 0.5 * u);
    ctx.font = `bold ${12 * u}px sans-serif`;
    ctx.lineWidth = 3 * u;
    ctx.strokeStyle = "rgba(255,255,255,.9)";
    ctx.strokeText(r.name, r.x, r.y - 19 * u);   // just above the point, as in the minimap
    ctx.fillStyle = col;
    ctx.fillText(r.name, r.x, r.y - 19 * u);
  });

  const pose = poseAt(video.currentTime);
  if (pose && state.proj.floors[pose.floor]?.id === state.viewFloor) {
    ctx.strokeStyle = "#111";
    ctx.lineWidth = 2.5 * u;
    ctx.beginPath();
    ctx.arc(pose.x, pose.y, 15 * u, 0, Math.PI * 2);
    ctx.stroke();
  }
}

// ---------------- track sampling ----------------

function poseAt(t) {
  const tr = state.track;
  if (!tr || !tr.x.length) return null;
  const f = Math.max(0, Math.min(tr.x.length - 1, t * tr.fps));
  const i = Math.floor(f), j = Math.min(i + 1, tr.x.length - 1), a = f - i;
  const al = tr.a?.length ? tr.a[i] + ((tr.a[j] ?? tr.a[i]) - tr.a[i]) * a : 1;
  const pa = tr.pa?.length ? tr.pa[i] + ((tr.pa[j] ?? tr.pa[i]) - tr.pa[i]) * a : 1;
  const pf = tr.pf?.length ? tr.pf[i] : tr.floor[i];   // the plan on screen (may differ from the marker's floor)
  // across a fade switch (room or floor) don't slide between the two rooms
  if (tr.floor[i] !== tr.floor[j] || (tr.a?.[i] < 1 && tr.a?.[j] < 1 && (tr.x[i] !== tr.x[j] || tr.y[i] !== tr.y[j])))
    return { x: tr.x[i], y: tr.y[i], floor: tr.floor[i], a: al, pa, pf };
  return { x: tr.x[i] + (tr.x[j] - tr.x[i]) * a, y: tr.y[i] + (tr.y[j] - tr.y[i]) * a, floor: tr.floor[i], a: al, pa, pf };
}

// ---------------- minimap preview (server-rendered panel + marker sprite) ----------------

function contentRect() {
  const vw = video.videoWidth || state.proj.video.width, vh = video.videoHeight || state.proj.video.height;
  const ew = video.clientWidth, eh = video.clientHeight;
  const k = Math.min(ew / vw, eh / vh);
  const w = vw * k, h = vh * k;
  return { x: (ew - w) / 2, y: (eh - h) / 2, w, h };
}

// which plan is on screen at time t and how opaque (works with or without room records)
function planAt(t) {
  const tr = state.track;
  if (!tr?.pf?.length) return { pf: tr?.x?.length ? 0 : -1, pa: 1 };
  const i = Math.max(0, Math.min(tr.pf.length - 1, Math.round(t * tr.fps)));
  return { pf: tr.pf[i], pa: tr.pa[i] };
}

function drawOverlay() {
  const ctx = overlay.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  const m = state.mini;
  if (!state.proj || !m || !$("#previewToggle").checked) return;
  const pose = poseAt(video.currentTime);
  const { pf: fl, pa } = planAt(video.currentTime);
  if (fl < 0 || pa <= 0) return;   // no plan on screen at this time
  const F = m.floors[fl];
  if (!F?.img) return;
  const k = overlay.width / m.frame[0];
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.imageSmoothingQuality = "high";
  ctx.globalAlpha = pa;
  ctx.drawImage(F.img, m.x0, m.y0, m.w, m.h);
  ctx.globalAlpha = 1;
  if (pose && pose.floor === fl) {   // the marker is drawn only when it is on the plan that is on screen
    const px = m.x0 + F.ox + pose.x * F.scale, py = m.y0 + F.oy + pose.y * F.scale;
    const hs = m.marker.half;
    ctx.globalAlpha = state.proj.settings.opacity * pose.a * pa;
    ctx.drawImage(markerSprite(m.marker, performance.now() / 1000), px - hs - 0.5, py - hs - 0.5, 2 * hs + 1, 2 * hs + 1);
    ctx.globalAlpha = 1;
  }
}

// glow brightness 0..1 at time t: the renderer's curve (there it follows video time, here the wall clock,
// so the marker keeps breathing even while the video is paused)
function pulseLevel(mk, t) {
  return 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / mk.pulse.period);
}

// keep the glow animating while paused (during playback loop() already redraws every frame)
function glowLoop() {
  if (state.proj && state.mini?.marker?.glow && video.paused && $("#previewToggle").checked) drawOverlay();
  requestAnimationFrame(glowLoop);
}
requestAnimationFrame(glowLoop);

// compose shadow -> glow (breathing) -> body on a scratch canvas at full alpha, then the caller fades it as one
function markerSprite(mk, t) {
  const c = mk.canvas, n = 2 * mk.half + 1;
  if (c.width !== n) { c.width = n; c.height = n; }
  const g = c.getContext("2d");
  g.clearRect(0, 0, n, n);
  g.drawImage(mk.layers.shadow, 0, 0);
  if (mk.glow) {
    g.globalAlpha = mk.pulse.min + (1 - mk.pulse.min) * pulseLevel(mk, t);
    g.drawImage(mk.layers.glow, 0, 0);
    g.globalAlpha = 1;
  }
  g.drawImage(mk.layers.body, 0, 0);
  return c;
}

// ---------------- timeline ----------------

function drawTimeline() {
  if (!state.proj) return;
  const dpr = window.devicePixelRatio || 1;
  const ctx = timeline.getContext("2d");
  const W = timeline.width, H = timeline.height;
  const dur = state.proj.video.duration || 1;
  const X = (t) => (t / dur) * W;
  ctx.clearRect(0, 0, W, H);

  // room stays as coloured bands
  const bandY = 16 * dpr, bandH = 26 * dpr;
  state.events.forEach((e, i) => {
    const room = roomById(e.room);
    if (!room) return;
    const x0 = i === 0 ? 0 : X(e.t), x1 = i + 1 < state.events.length ? X(state.events[i + 1].t) : W;
    ctx.fillStyle = roomColor(room) + "44";
    ctx.fillRect(x0, bandY, x1 - x0, bandH);
    ctx.fillStyle = roomColor(room);
    ctx.font = `${11 * dpr}px sans-serif`;
    ctx.textBaseline = "middle";
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, bandY, x1 - x0, bandH);
    ctx.clip();
    ctx.fillText(room.name, x0 + 8 * dpr, bandY + bandH / 2);
    ctx.restore();
  });

  if (state.analysis) {
    ctx.fillStyle = "#f59e0b";
    for (const sg of state.analysis.suggestions) ctx.fillRect(X(sg.t) - 1.5 * dpr, 0, 3 * dpr, 10 * dpr);
  }
  // each floor's show window as a thin strip just above the bands (grey = plan hidden there)
  const sy = 11 * dpr, sh = 4 * dpr;
  ctx.fillStyle = "rgba(120,120,120,.25)";
  ctx.fillRect(0, sy, W, sh);
  state.proj.floors.forEach((f, i) => {
    if (f.show_start == null && f.show_end == null) return;
    const x0 = X(f.show_start ?? 0), x1 = X(Math.min(f.show_end ?? dur, dur));
    ctx.fillStyle = i % 2 ? "rgba(139, 92, 246, .8)" : "rgba(16, 185, 129, .8)";
    ctx.fillRect(x0, sy, Math.max(x1 - x0, dpr), sh);
  });
  // when the marker is actually on the move: a strip from departure to arrival along the bottom of the bands
  for (const m of state.track?.moves || []) {
    if (m.end <= m.start) continue;
    const x0 = X(m.start), x1 = X(Math.min(m.end, dur)), y = bandY + bandH - 6 * dpr, h = 6 * dpr;
    ctx.fillStyle = m.kind === "fade" ? "rgba(139, 92, 246, .85)" : "rgba(37, 99, 235, .85)";
    ctx.fillRect(x0, y, Math.max(x1 - x0, 2 * dpr), h);
    ctx.fillRect(x0 - dpr, y - 3 * dpr, 2 * dpr, h + 3 * dpr);   // departure tick
    ctx.fillRect(x1 - dpr, y - 3 * dpr, 2 * dpr, h + 3 * dpr);   // arrival tick
  }
  for (const e of state.events) {
    const room = roomById(e.room);
    const x = X(e.t), y = bandY + bandH + 8 * dpr, r = 5 * dpr;
    ctx.fillStyle = room ? roomColor(room) : "#888";
    ctx.beginPath();
    ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y);
    ctx.fill();
    ctx.fillRect(x - 0.5 * dpr, bandY, 1 * dpr, bandH);
  }
  ctx.fillStyle = "#111";
  ctx.fillRect(X(video.currentTime) - dpr, 0, 2 * dpr, H);
}

function timelineTime(e) {
  const r = timeline.getBoundingClientRect();
  return { t: Math.max(0, Math.min(state.proj.video.duration, ((e.clientX - r.left) / r.width) * state.proj.video.duration)), r };
}

function nearest(list, t, r, px = 7) {
  const dur = state.proj.video.duration;
  return list.find((x) => Math.abs(((x.t - t) / dur) * r.width) < px);
}

timeline.addEventListener("pointerdown", (e) => {
  if (!state.proj) return;
  const { t, r } = timelineTime(e);
  const ev = nearest(state.events, t, r);
  if (ev) {
    timeline.setPointerCapture(e.pointerId);
    state.tlDrag = { ev, moved: false };
    return;
  }
  const sug = state.analysis && nearest(state.analysis.suggestions, t, r);
  video.currentTime = sug ? sug.t : t;
});

timeline.addEventListener("pointermove", (e) => {
  if (!state.proj) return;
  const { t, r } = timelineTime(e);
  const d = state.tlDrag;
  if (d) {
    d.moved = true;
    d.ev.t = +t.toFixed(3);
    video.currentTime = t;
    drawTimeline();
    return;
  }
  const ev = nearest(state.events, t, r);
  const sug = state.analysis && nearest(state.analysis.suggestions, t, r);
  const mv = state.track?.moves?.find((m) => m.end > m.start && t >= m.start && t <= m.end);
  const win = state.proj.floors.filter((f) => f.show_start != null || f.show_end != null)
    .map((f) => `${f.label} 도면 ${f.show_start != null ? fmtTime(f.show_start) : "처음"} ~ ${f.show_end != null ? fmtTime(f.show_end) : "끝"}`).join(" · ");
  timeline.style.cursor = ev ? "ew-resize" : "pointer";
  timeline.title = ev ? `${fmtTime(ev.t)} → ${roomById(ev.room)?.name || ""} (드래그로 조정)` : sug ? `${fmtTime(sug.t)} · AI 추천: ${sug.reason}`
    : mv ? `${mv.kind === "fade" ? "스르르 전환" : "이동"} 출발 ${fmtTime(mv.start)} → 도착 ${fmtTime(mv.end)} (${(mv.end - mv.start).toFixed(1)}초)`
    : win ? `${fmtTime(t)} · ${win}` : fmtTime(t);
});

timeline.addEventListener("pointerup", () => {
  const d = state.tlDrag;
  state.tlDrag = null;
  if (!d) return;
  if (d.moved) saveRoomsEvents();
  else video.currentTime = d.ev.t;
});

// ---------------- transport / sync ----------------

$("#playBtn").addEventListener("click", () => (video.paused ? video.play() : video.pause()));
video.addEventListener("play", () => { $("#playBtn").textContent = "⏸ 정지"; loop(); });
video.addEventListener("pause", () => { $("#playBtn").textContent = "▶ 재생"; tick(); });
video.addEventListener("seeked", tick);
video.addEventListener("timeupdate", () => video.paused && tick());
$("#previewToggle").addEventListener("change", drawOverlay);

for (const b of $$("[data-seek]")) b.addEventListener("click", () => { video.currentTime += +b.dataset.seek; });
for (const b of $$("[data-frame]")) b.addEventListener("click", () => stepFrame(+b.dataset.frame));

// play just the stretch around a room change, then stop
let clipStop = null;
function playAround(t, pad = 1.5) {
  const dur = state.proj.video.duration;
  clipStop = Math.min(dur, t + pad + (+state.proj.settings.transition_sec || 0) / 2);
  video.currentTime = Math.max(0, t - pad);
  video.play();
}
video.addEventListener("timeupdate", () => {
  if (clipStop !== null && video.currentTime >= clipStop) { video.pause(); clipStop = null; }
});
video.addEventListener("pause", () => { clipStop = null; });
$("#speedSelect").addEventListener("change", (e) => { video.playbackRate = +e.target.value; });
video.addEventListener("loadedmetadata", () => { video.playbackRate = +$("#speedSelect").value; });

function stepFrame(n) {
  video.pause();
  video.currentTime = Math.max(0, video.currentTime + n / (state.proj?.video.fps || 30));
}

let lastRoomKey = "";
function followFloor() {
  // the plan editor follows the floor you are on while playing
  const pose = poseAt(video.currentTime);
  const fid = pose && state.proj.floors[pose.floor]?.id;
  if (fid && fid !== state.viewFloor && !video.paused) {
    state.viewFloor = fid;
    renderFloorTabs();
    resizePlan();
  }
}

function tick() {
  if (!state.proj) return;
  $("#timeLabel").textContent = `${fmtTime(video.currentTime)} / ${fmtTime(state.proj.video.duration || 0)}`;
  followFloor();
  drawOverlay();
  drawPlan();
  drawTimeline();
  const key = `${roomAt(video.currentTime)?.id}|${activeEventIndex()}`;
  if (key !== lastRoomKey) { lastRoomKey = key; renderRooms(); renderEvents(); }
}

function loop() {
  if (clipStop !== null && video.currentTime >= clipStop) video.pause();
  if (video.paused) return;
  tick();
  requestAnimationFrame(loop);
}

const TOOL_KEYS = { KeyL: "line", KeyT: "thinline", KeyD: "door", KeyS: "stairs", KeyB: "toilet", KeyR: "rect", KeyC: "circle",
  KeyW: "basin", KeyK: "sink", KeyI: "induction", KeyO: "closet", KeyF: "flip", KeyV: "copy", KeyA: "resize", KeyE: "erase", KeyX: "delete" };

for (const ev of ["keydown", "keyup"]) document.addEventListener(ev, (e) => {
  if (e.key === "Shift") state.shiftDown = e.shiftKey;
  if (["Control", "Meta", "Shift"].includes(e.key) && state.mode === "draw") { moveCursor(e, state.hover); drawPlan(); }
});
window.addEventListener("blur", () => { state.shiftDown = false; });

document.addEventListener("keydown", (e) => {
  // typing fields keep their keys; checkboxes / sliders / colour pickers don't block shortcuts
  const typing = e.target.matches("input:not([type=checkbox]):not([type=range]):not([type=color]), select, textarea");
  if (!state.proj || typing || document.querySelector("dialog[open]")) return;
  if (state.mode === "draw") {
    if ((e.ctrlKey || e.metaKey) && e.code === "KeyZ") { e.preventDefault(); undoEdit(); return; }
    if (TOOL_KEYS[e.code] && !e.ctrlKey && !e.metaKey) { setTool(TOOL_KEYS[e.code]); return; }
    if (e.code === "BracketLeft" || e.code === "BracketRight") {   // [ / ] = smaller / bigger eraser
      const inp = $("#eraseSize");
      inp.value = Math.max(+inp.min, Math.min(+inp.max, +inp.value + (e.code === "BracketRight" ? 3 : -3)));
      flash(`지우개 크기 ${inp.value}`);
      if (state.tool !== "erase") setTool("erase");
      drawPlan();
      return;
    }
    if (e.code === "Delete" || e.code === "Backspace") return;
  } else if ((e.ctrlKey || e.metaKey) && e.code === "KeyZ") {   // ① / ②: undo route bending (also the 초기화 button)
    e.preventDefault();
    undoRoute();
    return;
  }
  if (e.code === "Space") { e.preventDefault(); video.paused ? video.play() : video.pause(); }
  else if (e.code === "ArrowLeft") { e.preventDefault(); if (e.ctrlKey || e.metaKey) stepFrame(-1); else video.currentTime -= e.shiftKey ? 1 : 10; }
  else if (e.code === "ArrowRight") { e.preventDefault(); if (e.ctrlKey || e.metaKey) stepFrame(1); else video.currentTime += e.shiftKey ? 1 : 10; }
  else if (/^Digit[1-9]$/.test(e.code) || /^Numpad[1-9]$/.test(e.code)) {
    const room = state.rooms[+e.code.slice(-1) - 1];
    if (room) recordRoom(room);
  } else if (e.code === "Delete" || e.code === "Backspace") {
    const t = video.currentTime;
    const ev = state.events.reduce((b, x) => (Math.abs(x.t - t) < Math.abs((b?.t ?? Infinity) - t) ? x : b), null);
    if (ev && Math.abs(ev.t - t) < 1) { state.events.splice(state.events.indexOf(ev), 1); saveRoomsEvents(); flash("기록 삭제"); }
  }
});

function resizePlan() {
  const img = viewImg();
  if (!img) return;
  const dpr = window.devicePixelRatio || 1;
  const cssW = planCv.clientWidth || 400;
  planCv.width = Math.round(cssW * dpr);
  planCv.height = Math.round((cssW * dpr * img.height) / img.width);
}

function resizeAll() {
  if (!state.proj) return;
  const dpr = window.devicePixelRatio || 1;
  const cr = contentRect();
  Object.assign(overlay.style, { left: `${cr.x}px`, top: `${cr.y}px`, width: `${cr.w}px`, height: `${cr.h}px` });
  overlay.width = Math.round(cr.w * dpr);
  overlay.height = Math.round(cr.h * dpr);
  resizePlan();
  timeline.width = Math.round(timeline.clientWidth * dpr);
  timeline.height = Math.round(64 * dpr);
  tick();
}
window.addEventListener("resize", resizeAll);
video.addEventListener("loadeddata", resizeAll);

// ---------------- analysis & render ----------------

$("#analyzeBtn").addEventListener("click", async () => {
  const btn = $("#analyzeBtn"), msg = $("#analyzeMsg");
  btn.disabled = true;
  try {
    const { job } = await api(`/api/projects/${state.proj.id}/analyze`, { method: "POST" });
    await pollJob(job, (j) => (msg.textContent = `분석 중… ${Math.round(j.progress * 100)}%`));
    state.analysis = await api(`/api/projects/${state.proj.id}/analysis`);
    msg.textContent = `완료: 추천 시점 ${state.analysis.suggestions.length}개 (타임라인 주황색)`;
    drawTimeline();
  } catch (err) {
    msg.textContent = "실패: " + err.message;
  } finally {
    btn.disabled = false;
  }
});

$("#renderBtn").addEventListener("click", async () => {
  const outputs = $$("input[name=out]:checked").map((c) => c.value);
  if (!outputs.length) return alert("출력 형식을 선택해주세요");
  const btn = $("#renderBtn"), prog = $("#renderProg"), msg = $("#renderMsg");
  btn.disabled = true;
  prog.classList.remove("hidden");
  prog.value = 0;
  try {
    await flushSaves();
    const { job } = await api(`/api/projects/${state.proj.id}/render`, { method: "POST", body: JSON.stringify({ outputs }) });
    const done = await pollJob(job, (j) => { prog.value = j.progress; msg.textContent = j.message || "렌더링 중…"; });
    msg.textContent = "완료!";
    const proj = await api(`/api/projects/${state.proj.id}`);
    renderDownloads(proj.outputs, done.result.files);
  } catch (err) {
    msg.textContent = "실패: " + err.message;
  } finally {
    btn.disabled = false;
    prog.classList.add("hidden");
  }
});

function outputLabel(f) {
  if (f === "composite.mp4") return "합성 영상 (mp4)";
  if (f === "overlay.mov") return "투명 오버레이 (mov): 편집 영상 위 트랙에 0초 위치로 올려 사용";
  const m = f.match(/^minimap_(.+)\.png$/);
  if (m) return `미니맵 이미지 ${m[1]} (png, 칠판 스타일)`;
  const c = f.match(/^plan_(.+)\.png$/);
  if (c) return `홍보용 미니 도면 ${c[1]} (png, 흰 배경 선 도면)`;
  return f;
}

function renderDownloads(files, fresh = []) {
  const v = Date.now();
  const items = (files || []).map((f) =>
    `<li><a href="${fileUrl("outputs/" + f, true)}&v=${v}">⬇ ${escapeHtml(outputLabel(f))}</a>${fresh.includes(f) ? " <b>new</b>" : ""}</li>`);
  if (state.proj) items.push(`<li><a href="${fileUrl("project.json", true)}">⬇ 프로젝트 설정 (json)</a></li>`);
  $("#downloads").innerHTML = items.join("");
}

// ---------------- utils ----------------

let flashTimer;
function flash(text) {
  const el = $("#flash");
  el.textContent = "✓ " + text;
  el.classList.add("on");
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => el.classList.remove("on"), 1500);
}

function fmtDur(t) {
  t = Math.round(t || 0);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}
function fmtSize(b) {
  return b >= 1e9 ? `${(b / 1e9).toFixed(1)}GB` : `${Math.max(1, Math.round((b || 0) / 1e6))}MB`;
}
function fmtTime(t) {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}
function escapeHtml(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]); }
function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

// ---------------- boot ----------------

refreshPresets();
route();
