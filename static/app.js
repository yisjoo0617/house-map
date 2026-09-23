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
}

$("#floorTabs").addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.floor) {
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
const MOVE_SETTINGS = ["transition", "fade_sec", "transition_sec", "follow_path", "move_timing", "cross_sec", "move_anchor", "line_mode", "line_threshold"];

function syncSettingLabels() {
  const s = state.proj?.settings;
  if (!s) return;
  $("#crossVal").textContent = `도면 끝→끝 ${(+s.cross_sec).toFixed(1)}초`;
  $("#transVal").textContent = `${(+s.transition_sec).toFixed(1)}초`;
  $("#fadeVal").textContent = `${(+s.fade_sec).toFixed(1)}초`;
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

async function refreshTrack() {
  state.track = await api(`/api/projects/${state.proj.id}/track?fps=30`);
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
      <td>${i > 0 ? `<button data-ev-play="${i}" title="이 이동만 재생해서 확인 (앞뒤 1.5초)">▶ 이동 확인</button>` : ""}</td>
      <td><button data-ev-del="${i}" title="삭제">✕</button></td>
    </tr>`).join("") || `<tr><td colspan="3" class="muted">영상을 재생하며 숫자키를 누르거나 방을 클릭하세요</td></tr>`;
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
  const k = viewImg().width / r.width;
  return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k };
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
  const hit = hitRoom(p);
  if (hit) {
    planCv.setPointerCapture(e.pointerId);
    state.drag = { room: hit, start: p, moved: false };
    return;
  }
  const name = prompt("방 이름 (예: Living Room, Kitchen, Bedroom)", suggestRoomName());
  if (name === null) return;
  const room = { id: "r" + Math.random().toString(36).slice(2, 8), name: name.trim(), floor: state.viewFloor, x: p.x, y: p.y };
  state.rooms.push(room);
  if (!state.events.length) state.events.push({ t: 0, room: room.id }); // first room = starting room
  saveRoomsEvents();
});

planCv.addEventListener("pointermove", (e) => {
  if (state.mode === "draw") return drawMove(e);
  const d = state.drag;
  if (!d) return;
  const p = planPoint(e);
  if (!d.moved && Math.hypot(p.x - d.start.x, p.y - d.start.y) < 4 * cssPx()) return;
  d.moved = true;
  d.room.x = p.x;
  d.room.y = p.y;
  drawPlan();
});

planCv.addEventListener("pointerup", (e) => {
  if (state.mode === "draw") return drawUp(e);
  const d = state.drag;
  state.drag = null;
  if (!d) return;
  if (d.moved) saveRoomsEvents();
  else recordRoom(d.room);
});

planCv.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (state.mode === "draw") return;
  const hit = hitRoom(planPoint(e));
  if (hit) deleteRoom(hit);
});

function suggestRoomName() {
  const names = ["Entrance", "Living Room", "Kitchen", "Bedroom", "Bathroom", "Pantry", "Dressing Room", "Utility Room", "Balcony", "Study"];
  return names.find((n) => !state.rooms.some((r) => r.name === n)) || "";
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
  $("#planHint").textContent = mode === "draw"
    ? "빨간 선 = 자동으로 인식된 벽 · 파란 선 = 직접 그린 선 · 문과 계단은 직접 그리고, 가구 찌꺼기는 지우개로 지우세요"
    : "빈 곳 클릭 = 방 추가 · 방 클릭 = 현재 시각에 그 방으로 이동 기록 · 드래그 = 위치 수정 · 우클릭 = 방 삭제";
  planCv.style.cursor = mode === "draw" ? "crosshair" : "";
  if (mode === "draw") loadStruct();
  drawPlan();
}

function setTool(tool) {
  state.tool = tool;
  for (const b of $$("[data-tool]")) b.classList.toggle("active", b.dataset.tool === tool);
}

async function loadStruct() {
  if (!state.proj) return;
  const fid = state.viewFloor;
  state.structImgs[fid] = await loadImage(`/api/projects/${state.proj.id}/structure/${fid}.png?v=${Date.now()}`);
  drawPlan();
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

function snapPoint(p, from, free) {
  // snap to existing endpoints first, then keep lines horizontal / vertical
  const tol = 9 * cssPx();
  for (const e of curEdits()) {
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

function drawDown(e) {
  const p = planPoint(e);
  planCv.setPointerCapture(e.pointerId);
  const t = state.tool;
  if (t === "delete") {
    const hit = hitEdit(p);
    if (hit) { pushUndo(); curEdits().splice(curEdits().indexOf(hit), 1); saveEdits(hit.type === "erase"); }
    return;
  }
  if (t === "door") {
    const hit = hitEdit(p, ["door"]);
    if (hit) { state.drawing = { type: "flip", door: hit, start: p }; return; }
  }
  const s = t === "erase" ? p : snapPoint(p, null, e.altKey);
  const r = (+$("#eraseSize").value) * cssPx();
  state.drawing = t === "erase" ? { type: "erase", pts: [[s.x, s.y]], r }
    : { type: t, start: s, end: s };
  drawPlan();
}

function drawMove(e) {
  const d = state.drawing;
  const p = planPoint(e);
  state.hover = p;
  if (!d) { if (state.tool === "erase") drawPlan(); return; }
  if (d.type === "erase") d.pts.push([p.x, p.y]);
  else if (d.type !== "flip") d.end = (d.type === "line" || d.type === "thinline") ? snapPoint(p, d.start, e.altKey) : p;
  drawPlan();
}

function drawUp() {
  const d = state.drawing;
  state.drawing = null;
  if (!d) return;
  const len = d.start ? Math.hypot(d.end.x - d.start.x, d.end.y - d.start.y) : 0;
  const min = 4 * cssPx();
  pushUndo();
  if (d.type === "flip") d.door.flip = !d.door.flip;
  else if (d.type === "erase") curEdits().push({ type: "erase", pts: d.pts, r: d.r });
  else if (len < min) { state.undo.pop(); drawPlan(); return; }
  else if (d.type === "line") curEdits().push({ type: "line", pts: [[d.start.x, d.start.y], [d.end.x, d.end.y]] });
  else if (d.type === "door") curEdits().push({ type: "door", hinge: [d.start.x, d.start.y], end: [d.end.x, d.end.y], flip: false });
  else if (d.type === "stairs") curEdits().push({ type: "stairs", a: [d.start.x, d.start.y], b: [d.end.x, d.end.y] });
  else if (d.type === "thinline") curEdits().push({ type: "line", pts: [[d.start.x, d.start.y], [d.end.x, d.end.y]], thin: true });
  else curEdits().push({ ...previewShape(d), thin: $("#shapesThin").checked });  // toilet / rect / circle
  saveEdits(d.type === "erase");
}

function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p.x - a[0]) * dx + (p.y - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p.x - (a[0] + t * dx), p.y - (a[1] + t * dy));
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

function toiletOutline(e) {
  const [ax, ay] = e.a, [bx, by] = e.b;
  const r = Math.hypot(bx - ax, by - ay), ang = Math.atan2(by - ay, bx - ax);
  return ring(ax, ay, r, ang - Math.PI / 2, ang + Math.PI / 2);  // arc; the closing chord is the flat side
}

const polySegments = (pts, closed) => {
  const segs = pts.slice(1).map((q, i) => [pts[i], q]);
  if (closed) segs.push([pts[pts.length - 1], pts[0]]);
  return segs;
};

function editSegments(e) {
  if (e.type === "rect") {
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

function hitEdit(p, types) {
  let best = null, bd = 8 * cssPx();
  for (const e of curEdits()) {
    if (types && !types.includes(e.type)) continue;
    let d = Math.min(...editSegments(e).map(([a, b]) => segDist(p, a, b)));
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
    const [ax, ay] = e.a, [bx, by] = e.b;
    const r = Math.hypot(bx - ax, by - ay), ang = Math.atan2(by - ay, bx - ax);
    ctx.arc(ax, ay, r, ang - Math.PI / 2, ang + Math.PI / 2);
    ctx.closePath();
  } else if (e.type === "stairs") {
    const x0 = Math.min(e.a[0], e.b[0]), x1 = Math.max(e.a[0], e.b[0]);
    const y0 = Math.min(e.a[1], e.b[1]), y1 = Math.max(e.a[1], e.b[1]);
    const w = x1 - x0, h = y1 - y0;
    const n = e.steps || Math.min(18, Math.max(4, Math.round(Math.max(w, h) / (Math.min(w, h) * 0.45 + 1e-6))));
    ctx.rect(x0, y0, w, h);
    for (let i = 1; i < n; i++) {
      if (h >= w) { ctx.moveTo(x0, y0 + h * i / n); ctx.lineTo(x1, y0 + h * i / n); }
      else { ctx.moveTo(x0 + w * i / n, y0); ctx.lineTo(x0 + w * i / n, y1); }
    }
  }
  ctx.stroke();
}

function drawEditsLayer(ctx, u) {
  ctx.lineCap = ctx.lineJoin = "round";
  for (const e of curEdits()) {
    if (e.type === "erase") {
      ctx.strokeStyle = "rgba(236,72,153,.25)";
      ctx.lineWidth = e.r * 2;
      ctx.beginPath();
      e.pts.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])));
      if (e.pts.length === 1) ctx.lineTo(e.pts[0][0] + 0.01, e.pts[0][1]);
      ctx.stroke();
    } else {
      ctx.strokeStyle = "#2563eb";
      ctx.lineWidth = (e.thin ? 1.3 : 2.5) * u;
      drawEditShape(ctx, e);
    }
  }
  const d = state.drawing;
  if (d && d.type !== "flip") {
    if (d.type === "erase") {
      ctx.strokeStyle = "rgba(236,72,153,.45)";
      ctx.lineWidth = d.r * 2;
      ctx.beginPath();
      d.pts.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])));
      ctx.stroke();
    } else {
      const shape = previewShape(d);
      const thin = d.type === "thinline" || (["toilet", "rect", "circle"].includes(d.type) && $("#shapesThin").checked);
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
  if (drawing && state.structImgs[state.viewFloor]) ctx.drawImage(state.structImgs[state.viewFloor], 0, 0, planCv.width, planCv.height);
  ctx.setTransform(s, 0, 0, s, 0, 0);

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
    ctx.strokeText(r.name, r.x, r.y + 20 * u);
    ctx.fillStyle = col;
    ctx.fillText(r.name, r.x, r.y + 20 * u);
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
  // across a fade switch (room or floor) don't slide between the two rooms
  if (tr.floor[i] !== tr.floor[j] || (tr.a?.[i] < 1 && tr.a?.[j] < 1 && (tr.x[i] !== tr.x[j] || tr.y[i] !== tr.y[j])))
    return { x: tr.x[i], y: tr.y[i], floor: tr.floor[i], a: al };
  return { x: tr.x[i] + (tr.x[j] - tr.x[i]) * a, y: tr.y[i] + (tr.y[j] - tr.y[i]) * a, floor: tr.floor[i], a: al };
}

// ---------------- minimap preview (server-rendered panel + marker sprite) ----------------

function contentRect() {
  const vw = video.videoWidth || state.proj.video.width, vh = video.videoHeight || state.proj.video.height;
  const ew = video.clientWidth, eh = video.clientHeight;
  const k = Math.min(ew / vw, eh / vh);
  const w = vw * k, h = vh * k;
  return { x: (ew - w) / 2, y: (eh - h) / 2, w, h };
}

function drawOverlay() {
  const ctx = overlay.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  const m = state.mini;
  if (!state.proj || !m || !$("#previewToggle").checked) return;
  const pose = poseAt(video.currentTime);
  const fl = pose ? pose.floor : 0;
  const F = m.floors[fl];
  if (!F?.img) return;
  const k = overlay.width / m.frame[0];
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(F.img, m.x0, m.y0, m.w, m.h);
  if (pose) {
    const px = m.x0 + F.ox + pose.x * F.scale, py = m.y0 + F.oy + pose.y * F.scale;
    const hs = m.marker.half;
    ctx.globalAlpha = state.proj.settings.opacity * pose.a;
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
  timeline.style.cursor = ev ? "ew-resize" : "pointer";
  timeline.title = ev ? `${fmtTime(ev.t)} → ${roomById(ev.room)?.name || ""} (드래그로 조정)` : sug ? `${fmtTime(sug.t)} · AI 추천: ${sug.reason}`
    : mv ? `${mv.kind === "fade" ? "스르르 전환" : "이동"} 출발 ${fmtTime(mv.start)} → 도착 ${fmtTime(mv.end)} (${(mv.end - mv.start).toFixed(1)}초)` : fmtTime(t);
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

const TOOL_KEYS = { KeyL: "line", KeyT: "thinline", KeyD: "door", KeyS: "stairs", KeyB: "toilet", KeyR: "rect", KeyC: "circle", KeyE: "erase", KeyX: "delete" };

document.addEventListener("keydown", (e) => {
  // typing fields keep their keys; checkboxes / sliders / colour pickers don't block shortcuts
  const typing = e.target.matches("input:not([type=checkbox]):not([type=range]):not([type=color]), select, textarea");
  if (!state.proj || typing || document.querySelector("dialog[open]")) return;
  if (state.mode === "draw") {
    if ((e.ctrlKey || e.metaKey) && e.code === "KeyZ") { e.preventDefault(); undoEdit(); return; }
    if (TOOL_KEYS[e.code] && !e.ctrlKey && !e.metaKey) { setTool(TOOL_KEYS[e.code]); return; }
    if (e.code === "Delete" || e.code === "Backspace") return;
  }
  if (e.code === "Space") { e.preventDefault(); video.paused ? video.play() : video.pause(); }
  else if (e.code === "ArrowLeft") { e.preventDefault(); e.shiftKey ? stepFrame(-1) : (video.currentTime -= 1); }
  else if (e.code === "ArrowRight") { e.preventDefault(); e.shiftKey ? stepFrame(1) : (video.currentTime += 1); }
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
