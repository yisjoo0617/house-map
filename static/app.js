"use strict";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const ROOM_COLORS = ["#e11d48", "#2563eb", "#16a34a", "#f59e0b", "#9333ea", "#0891b2", "#ea580c", "#4f46e5", "#65a30d", "#db2777"];

const state = {
  proj: null,
  rooms: [],
  path: [],           // "③ 이동 지점": ordered points [{id, floor, x, y, arrive, depart, via?, mode?}]
  active: null,       // the selected point and time field: {id, field: "arrive"|"depart"} (⏺ 현재 writes into it)
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
    : p.moves ? `<span class="badge wip">작업 중</span>` : `<span class="badge">이동 지점 없음</span>`;
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
          <span>방 ${p.rooms} · 이동 ${p.moves}</span>
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
// while a project uploads, neither 만들기 nor 취소 can be pressed (Esc is blocked below): cancelling would only hide
// the dialog while the upload carries on and then yank the user into the new project
function setUploading(on) {
  $("#createBtn").disabled = on;
  for (const b of $$("#newDialog [data-close]")) b.disabled = on;
}
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
  setUploading(true);
  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/projects");
  xhr.upload.onprogress = (ev) => {
    prog.value = ev.loaded / ev.total;
    msg.textContent = prog.value < 1 ? `업로드 ${Math.round(prog.value * 100)}%` : "영상 확인 중…";
  };
  xhr.onload = () => {
    setUploading(false);
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
  xhr.onerror = () => { setUploading(false); err.textContent = "업로드 실패: 서버가 실행 중인지 확인하세요"; };
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
  try { await api(`/api/projects/${deleteId}`, { method: "DELETE" }); }
  catch (err) { alert("삭제할 수 없습니다: " + err.message); return; }
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
  if (state.proj && state.proj.id !== id) {
    await flushSaves().catch(() => {});
    video.pause();
    video.removeAttribute("src");   // the playhead of the previous project must not carry over
    video.load();
  }
  const proj = await api(`/api/projects/${id}`);
  state.viewFloor = null;
  state.undo = [];
  state.structImgs = {};
  state.active = null;
  // nothing of the previous project may linger: its bend-undo stack, track, minimap panels, drags and clip stop
  state.routeUndo = [];
  $("#routeUndoBtn").disabled = true;
  state.track = null;
  state.mini = null;
  state.tlDrag = null;
  state.drag = null;
  clipStop = null;
  lastMoveKey = "";
  applyProject(proj);
  state.analysis = proj.has_analysis ? await api(`/api/projects/${id}/analysis`) : null;
  $("#listView").classList.add("hidden");
  $("#workspace").classList.remove("hidden");
  $("#help").classList.add("hidden");
  showCrumb();
  updatePlanHint();
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
  state.path = (proj.path || []).map((q) => ({ ...q }));
  if (!state.viewFloor || !floorOf(state.viewFloor)) state.viewFloor = proj.floors[0].id;
  $("#titleInput").placeholder = proj.default_title;
  renderFloorTabs();
  renderRooms();
  renderMoves();
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
  tabs.push(`<button id="renameFloorBtn" title="선택한 층의 이름을 바꿉니다 (미니맵 상단의 1F 글자). 층 탭을 더블클릭해도 됩니다">✎ 이름 변경</button>`);
  tabs.push(`<button id="addFloorBtn" title="도면 이미지 추가">+ 층 추가</button>`);
  if (state.proj.floors.length > 1) tabs.push(`<button class="del" id="delFloorBtn">이 층 삭제</button>`);
  $("#floorTabs").innerHTML = tabs.join("");
  renderFloorShow();
}

// ---------------- per-floor show window (when this plan appears / disappears) ----------------

// a floor can be on screen in several windows: floor.shows = [{start, end}, ...] (null = video edge)
const floorShows = (f) => (f.shows ||= []);

function renderFloorShow() {
  const f = floorOf(state.viewFloor);
  if (!f) return;
  const v = (x) => (x == null ? "" : fmtTime(x));
  const rows = floorShows(f).map((w, i) => `
    <span class="show-row">
      <span class="muted">${floorShows(f).length > 1 ? `구간 ${i + 1}` : "구간"}</span>
      <label>시작 <input data-show="${i}:start" value="${v(w.start)}" placeholder="영상 처음" title="이 층 도면이 나타나는 시각 (분:초 또는 초)" /></label>
      <button data-show-now="${i}:start" title="현재 재생 시각을 시작으로">⏺ 현재</button>
      <span class="muted">~</span>
      <label>종료 <input data-show="${i}:end" value="${v(w.end)}" placeholder="영상 끝" title="이 층 도면이 사라지는 시각 (분:초 또는 초)" /></label>
      <button data-show-now="${i}:end" title="현재 재생 시각을 종료로">⏺ 현재</button>
      <button data-show-del="${i}" title="이 구간 삭제">✕</button>
    </span>`).join("");
  $("#floorShow").innerHTML = `
    <span class="muted">${escapeHtml(f.label)} 도면 노출</span>
    ${rows}
    <button data-show-add title="이 층 도면이 보이는 구간을 하나 더 추가합니다 (같은 층이 영상에 여러 번 나올 때)">+ 구간 추가</button>
    <span class="muted small">${showNote(f)}</span>`;
}

// checks: a window that ends before it starts, or overlaps another window (of this floor or another)
function showNote(f) {
  const mine = floorShows(f);
  for (const [i, w] of mine.entries()) {
    const a0 = w.start ?? 0, a1 = w.end ?? Infinity;
    if (a1 <= a0) return `⚠ 구간 ${i + 1}: 종료가 시작보다 앞입니다`;
    for (const [j, u] of mine.entries()) {
      if (j <= i) continue;
      const b0 = u.start ?? 0, b1 = u.end ?? Infinity;
      if (a0 < b1 && b0 < a1) return `⚠ 구간 ${i + 1}과 ${j + 1}이 겹칩니다`;
    }
    for (const g of state.proj.floors) {
      if (g === f) continue;
      for (const u of floorShows(g)) {
        const b0 = u.start ?? 0, b1 = u.end ?? Infinity;
        if (a0 < b1 && b0 < a1) return `⚠ 구간 ${i + 1}이 ${escapeHtml(g.label)} 노출 구간과 겹칩니다 (겹치는 동안은 나중에 시작한 층이 보입니다)`;
      }
    }
  }
  return mine.length ? "이 구간들에는 마커 위치와 상관없이 이 층 도면이 보이고, 마커는 이 층에 있을 때만 나타납니다"
    : "구간을 정하지 않으면 마커가 이 층에 있을 때 보입니다 · 같은 층이 영상에 여러 번 나오면 구간을 여러 개 추가하세요";
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
  const [i, key] = inp.dataset.show.split(":");
  const f = floorOf(state.viewFloor);
  const w = floorShows(f)[+i];
  if (!w) return;
  const v = parseTime(inp.value);
  if (v == null && inp.value.trim()) { flash("시각은 분:초 또는 초로 적어 주세요 (예: 1:23.5)"); renderFloorShow(); return; }
  w[key] = v;
  if (w.start == null && w.end == null) {   // both edges blank = no window at all (that is how the server reads it too)
    floorShows(f).splice(+i, 1);
    flash("시작·종료가 모두 비어 구간을 지웠습니다 · 영상 내내 보이게 하려면 시작에 0을 넣으세요");
  }
  renderFloorShow();
  saveEdits();
});
$("#floorShow").addEventListener("click", (e) => {
  const f = floorOf(state.viewFloor);
  const now = e.target.closest("[data-show-now]");
  const del = e.target.closest("[data-show-del]");
  if (now) {
    const [i, key] = now.dataset.showNow.split(":");
    const w = floorShows(f)[+i];
    if (!w) return;
    w[key] = +video.currentTime.toFixed(2);
  } else if (del) {
    floorShows(f).splice(+del.dataset.showDel, 1);
  } else if (e.target.closest("[data-show-add]")) {
    // a new window starts at the playhead and runs to the video end until its end is set
    floorShows(f).push({ start: +video.currentTime.toFixed(2), end: null });
  } else return;
  renderFloorShow();
  saveEdits();
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
  else if (b.id === "renameFloorBtn") renameFloor(state.viewFloor);
  else if (b.id === "addFloorBtn") $("#addFloorFile").click();
  else if (b.id === "delFloorBtn") {
    const f = floorOf(state.viewFloor);
    if (!confirm(`${f.label} 도면과 그 층의 방·기록을 삭제할까요?`)) return;
    await flushSaves();
    applyProject(await api(`/api/projects/${state.proj.id}/floors/${f.id}`, { method: "DELETE" }));
    state.undo = state.undo.filter((u) => u.fid !== f.id);   // Ctrl+Z must never write this floor's drawing onto a later floor with the same id
    delete state.structImgs[f.id];
    if (state.selectedEdit) state.selectedEdit = null;
    state.viewFloor = state.proj.floors[0].id;
    renderFloorTabs();
    await Promise.all([loadPlanImages(), refreshMinimap(), refreshTrack()]);
    resizeAll();
  }
});

function renameFloor(fid) {
  const f = floorOf(fid);
  if (!f) return;
  const label = prompt("층 이름 (미니맵 상단에 표시됩니다)", f.label);
  if (label == null || !label.trim()) return;
  f.label = label.trim();
  renderFloorTabs();
  renderRooms();
  renderMoves();
  api(`/api/projects/${state.proj.id}`, { method: "PUT", body: JSON.stringify({ floors: state.proj.floors }) }).then(refreshMinimap);
}

$("#floorTabs").addEventListener("dblclick", (e) => {
  const b = e.target.closest("[data-floor]");
  if (b) renameFloor(b.dataset.floor);
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
  if (state.mode === "draw") loadStruct();
  e.target.value = "";
});

// ---------------- settings ----------------

// settings that change where the marker is at a given time -> re-fetch the track
const MOVE_SETTINGS = ["fade_sec", "panel_fade_sec", "line_mode", "line_threshold"];

function syncSettingLabels() {
  const s = state.proj?.settings;
  if (!s) return;
  $("#fadeVal").textContent = `${(+s.fade_sec).toFixed(1)}초`;
  $("#panelFadeVal").textContent = `${(+s.panel_fade_sec).toFixed(1)}초`;
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

let settingsTimer, settingsRetrack = false;
function saveSettings(retrack) {
  settingsRetrack ||= retrack;   // several quick changes share one save: retrack if any of them needs it
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(async () => {
    settingsTimer = null;
    const needTrack = settingsRetrack;
    settingsRetrack = false;
    await api(`/api/projects/${state.proj.id}`, { method: "PUT", body: JSON.stringify({ settings: state.proj.settings }) });
    await refreshMinimap();
    if (needTrack) await refreshTrack();
    if (state.mode === "draw") loadStruct();
  }, 350);
}

let miniSeq = 0;
async function refreshMinimap() {
  const seq = ++miniSeq, pid = state.proj.id;
  const m = await api(`/api/projects/${pid}/minimap`);
  const [floorImgs, shadow, glow, body] = await Promise.all([
    Promise.all(m.floors.map((f) => loadImage(f.image))),
    loadImage(m.marker.images.shadow),
    loadImage(m.marker.images.glow),
    loadImage(m.marker.images.body),
  ]);
  if (seq !== miniSeq || state.proj?.id !== pid) return;   // a newer request is in flight, or the project was left
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

// ---------------- rooms & moves ----------------

let saveTimer;
function saveRoomsMoves() {
  renderRooms();
  renderMoves();
  drawPlan();
  drawTimeline();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 250);
}

async function doSave() {
  saveTimer = null;
  if (!state.proj) return;
  const pid = state.proj.id;
  await api(`/api/projects/${pid}`, { method: "PUT", body: JSON.stringify({ rooms: state.rooms, path: state.path }) });
  if (state.proj?.id !== pid) return;   // the project was closed while the save was in flight
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
  renderMoves();
  tick();
}

function renderRooms() {
  const tb = $("#roomTable tbody");
  tb.innerHTML = state.rooms.map((r, i) => `
    <tr>
      <td><span class="swatch" style="background:${roomColor(r)}"></span> ${i + 1}</td>
      <td><input data-room-name="${r.id}" value="${escapeHtml(r.name)}" /></td>
      <td>${escapeHtml(floorOf(r.floor)?.label || "")}</td>
      <td><button data-room-del="${r.id}" title="삭제">✕</button></td>
    </tr>`).join("") || `<tr><td colspan="4" class="muted">도면의 빈 곳을 클릭해서 방을 추가하세요</td></tr>`;
}

$("#roomTable").addEventListener("change", (e) => {
  const inp = e.target.closest("[data-room-name]");
  if (!inp) return;
  roomById(inp.dataset.roomName).name = inp.value.trim();
  saveRoomsMoves();
});
$("#roomTable").addEventListener("click", (e) => {
  const b = e.target.closest("[data-room-del]");
  if (b) deleteRoom(roomById(b.dataset.roomDel));
});

function deleteRoom(room) {
  state.rooms.splice(state.rooms.indexOf(room), 1);
  saveRoomsMoves();
  flash(`'${room.name}' 방 삭제`);
}

// ---------------- route bending (straight legs through points you set) ----------------
// A leg goes point k-1 -> via[0] -> via[1] -> ... -> point k in straight lines. "via" lives on point k.

// the legs of the path: {k, a: point k-1, b: point k}
const legs = () => state.path.slice(1).map((b, i) => ({ k: i + 1, a: state.path[i], b }));
const canBend = (leg) => leg.a.floor === leg.b.floor && leg.b.mode !== "jump";
const routePoly = (leg) => [[leg.a.x, leg.a.y], ...(leg.b.via || []), [leg.b.x, leg.b.y]];

// the walks that can be bent on the floor being viewed
function bendableMoves() {
  return legs().filter((l) => canBend(l) && l.a.floor === state.viewFloor);
}

// ---- undo for route bending: snapshots of every point's bend points, keyed by the point id so unrelated
// changes in between (a new point, a retimed one) are left alone ----

state.routeUndo = [];

function pushRouteUndo() {
  state.routeUndo.push(state.path.map((q) => [q.id, q.via ? JSON.stringify(q.via) : null]));
  if (state.routeUndo.length > 100) state.routeUndo.shift();
  $("#routeUndoBtn").disabled = false;
}

// drop the snapshot just pushed (the gesture turned out to be a plain click)
function popRouteUndo() {
  state.routeUndo.pop();
  $("#routeUndoBtn").disabled = !state.routeUndo.length;
}

// the leg into this point was reshaped (a point inserted before it or deleted): its old bends must not come back
function forgetRouteUndo(id) {
  state.routeUndo = state.routeUndo.map((snap) => snap.filter(([q]) => q !== id)).filter((snap) => snap.length);
  $("#routeUndoBtn").disabled = !state.routeUndo.length;
}

function undoRoute() {
  const last = state.routeUndo.pop();
  $("#routeUndoBtn").disabled = !state.routeUndo.length;
  if (!last) return;
  const snap = new Map(last);
  for (const q of state.path) {
    if (!snap.has(q.id)) continue;
    const via = snap.get(q.id);
    if (via) q.via = JSON.parse(via); else delete q.via;
  }
  saveRoomsMoves();
  flash("경로 되돌리기");
}

function clearRoute(pt) {   // straight away, no confirmation: Ctrl+Z (or ↶ in ④ 경로 꺾기) brings the bends back
  if (!pt.via?.length) return;
  pushRouteUndo();
  delete pt.via;
  saveRoomsMoves();
  flash("경로 초기화 · Ctrl+Z로 되돌리기");
}
$("#routeUndoBtn").addEventListener("click", undoRoute);

function updatePlanHint() {
  $("#planHint").textContent = state.mode === "draw"
    ? "빨간 선 = 자동으로 인식된 벽·문·계단 · 파란 선 = 직접 그린 것 · 도형(문·계단·변기·설비·사각형·원)은 드래그로 옮기고 끝점·모서리를 끌어 크기 조절 · 클릭 = 선택 → 선택한 도형만 드래그로 옮기고 손잡이로 크기 조절 (Del 삭제 · Ctrl+C 복사 · Ctrl+V 마우스 위치에 붙여넣기) · 뒤집기는 ⇄ 도구 · Ctrl+Shift+드래그 = 복사해서 옮기기"
    : state.mode === "route"
      ? "파란 선 = ③에서 정한 이동 경로 · 선 근처 클릭 = 그 자리에 꺾는 점 추가 · 점 드래그 = 옮기기 · 점 우클릭 = 삭제 · 이동 지점 표의 초기화 = 바로 직선으로 · Ctrl+Z = 되돌리기"
      : state.mode === "moves"
        ? "⌂ 첫 지점 · ● 지나는 지점 · 빈 곳 클릭 = 경로 끝에 지점 추가 (방 점을 클릭하면 그 위치) · 선 근처 클릭 = 그 사이에 지점 끼워 넣기 · 지점 클릭 = 선택 (시작·종료 시간 칸이 열리고 종료 칸이 먼저 선택됨, 첫 지점은 이동 시작 칸 하나, ⏺ 현재로 기록) · 드래그 = 옮기기 (앞뒤 이동이 함께 따라옵니다) · 더블클릭 = 그 시각으로 · 우클릭 또는 ✕ 지점 삭제 = 지점 삭제 (Del은 시간 칸에 커서가 없을 때)"
        : "빈 곳 클릭 = 그 자리에 방 이름 표시 (선이 없는 깨끗한 곳을 고르세요) · 드래그 = 위치 수정 · 우클릭 = 삭제 · 마커 이동은 ③ 이동 지점에서";
}

// nearest bend handle of any move on this floor: {ev, k} or null
function hitVia(p) {
  const tol = 12 * cssPx();
  let best = null, bd = tol;
  for (const ev of bendableMoves()) {
    (ev.b.via || []).forEach((q, k) => {
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
  if (!best) { flash("이 층에는 꺾을 수 있는 이동이 없습니다 (③에서 같은 층 안의 지점을 두 개 이상 찍으세요)"); return false; }
  (best.ev.b.via ||= []).splice(best.k, 0, [+p.x.toFixed(1), +p.y.toFixed(1)]);
  return true;
}

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
  if (state.mode === "moves") {
    const pt = hitPathPoint(p);
    if (pt) {   // a click selects the point (its time boxes appear, 종료 first); a drag moves it, both legs follow
      planCv.setPointerCapture(e.pointerId);
      state.drag = { pt, start: p, moved: false };
      setActive(pt, "depart");
      return;
    }
    const leg = hitLeg(p);
    if (leg) insertPoint(p, leg.k, leg.seg); else appendPoint(p);
    return;
  }
  if (state.mode === "route") {
    const h = hitVia(p);
    if (h) {
      planCv.setPointerCapture(e.pointerId);
      pushRouteUndo();   // dropped again on pointerup if the point did not move
      state.drag = { via: h.k, ev: h.ev, start: p, moved: false };
      return;
    }
    if (hitPathPoint(p)) return;   // a path point is never a bend
    pushRouteUndo();
    if (insertVia(p)) saveRoomsMoves(); else popRouteUndo();
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
  saveRoomsMoves();
  return room;
}

planCv.addEventListener("pointermove", (e) => {
  if (!viewImg()) return;   // the plan image is still loading (right after 층 추가)
  if (state.mode === "draw") return drawMove(e);
  const d = state.drag;
  if (!d) {
    if (state.mode === "moves" && viewImg()) {
      const q = planPoint(e);
      planCv.style.cursor = hitPathPoint(q) ? "grab" : hitLeg(q) ? "copy" : "crosshair";
    }
    return;
  }
  const p = planPoint(e);
  if (!d.moved && Math.hypot(p.x - d.start.x, p.y - d.start.y) < 4 * cssPx()) return;
  d.moved = true;
  if (d.via != null) d.ev.b.via[d.via] = [+p.x.toFixed(1), +p.y.toFixed(1)];
  else if (d.pt) { d.pt.x = +p.x.toFixed(1); d.pt.y = +p.y.toFixed(1); }
  else { d.room.x = p.x; d.room.y = p.y; }
  drawPlan();
});

planCv.addEventListener("pointerup", (e) => {
  if (state.mode === "draw") return drawUp(e);
  const d = state.drag;
  state.drag = null;
  if (!d) return;
  if (d.via != null) { if (d.moved) saveRoomsMoves(); else popRouteUndo(); return; }
  if (d.moved) saveRoomsMoves();   // a plain click on a room / point only selects it
  else if (d.pt) focusActiveBox();   // ...and puts the cursor in the selected time box (종료) beside the point
});

// double-click a path point: jump the video to its arrival (the first point: its departure)
planCv.addEventListener("dblclick", (e) => {
  if (state.mode !== "moves" || !viewImg()) return;
  const pt = hitPathPoint(planPoint(e));
  const t = pt && (ptIndex(pt) === 0 ? pt.depart : pt.arrive);
  if (t != null) { video.pause(); video.currentTime = t; }
});

planCv.addEventListener("pointerleave", () => { state.hover = null; if (state.mode === "draw" && !state.drawing) drawPlan(); });

planCv.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (state.mode === "draw" || !viewImg()) return;
  if (state.mode === "moves") {
    const pt = hitPathPoint(planPoint(e));
    if (pt) deletePoint(pt);
    return;
  }
  if (state.mode === "route") {
    const h = hitVia(planPoint(e));
    if (h) { pushRouteUndo(); h.ev.b.via.splice(h.k, 1); if (!h.ev.b.via.length) delete h.ev.b.via; saveRoomsMoves(); }
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

// ---------------- the path ("③ 이동 지점") ----------------
// state.path is the ordered list of points the marker passes: it rests at a point from its arrival until its
// departure, then travels to the next point, arriving at that point's arrival time. The end of one leg is
// always the start of the next (one shared point), and every time is the user's own. The first point is
// where the marker sits from the video start. "via" (bends) and "mode" (걸어서 / 순간이동) belong to the leg INTO a point.

const ptById = (id) => state.path.find((q) => q.id === id);
const ptIndex = (pt) => state.path.indexOf(pt);
const nowT = () => +video.currentTime.toFixed(2);
const FIELD_LABEL = { arrive: "시작", depart: "종료" };   // 시작 = when the marker reaches the point, 종료 = when it leaves
// the first point has no arrival (the marker is there from the video start), so its one time is shown as
// "이동 시작": to the user it is when the walk begins, not the end of anything
const fieldLabel = (pt, field) => (field === "depart" && ptIndex(pt) === 0 ? "이동 시작" : FIELD_LABEL[field]);

// which time boxes a point has: the first point only departs, every other point arrives and departs
const ptFields = (pt) => (ptIndex(pt) === 0 ? ["depart"] : ["arrive", "depart"]);

// the selected point and field, if the point still exists
function activePoint() {
  const a = state.active, pt = a && ptById(a.id);
  if (!pt) return null;
  const fields = ptFields(pt);
  return { pt, field: fields.includes(a.field) ? a.field : fields[0] };
}
const isActiveField = (pt, field) => { const ap = activePoint(); return !!ap && ap.pt === pt && ap.field === field; };
const isActivePoint = (pt) => state.active?.id === pt.id;

// selecting only re-marks what is on screen (no table rebuild), so a time box keeps its focus.
// field = null keeps the current field when the same point is re-selected, else the first empty one.
function setActive(pt, field) {
  if (!pt) state.active = null;
  else {
    const keep = state.active?.id === pt.id ? state.active.field : null;
    state.active = { id: pt.id, field: field || keep || firstEmptyField(pt) };
  }
  refreshActiveMarks();
  drawPlan();
  drawTimeline();
}

const firstEmptyField = (pt) => ptFields(pt).find((f) => pt[f] == null) || ptFields(pt)[0];

// the cursor goes into the active time box beside the point, text selected so typing replaces it
function focusActiveBox() {
  const inp = $("#planLabels input.active");
  if (inp && document.activeElement !== inp) { inp.focus(); inp.select(); }
}

function refreshActiveMarks() {
  const ap = activePoint();
  for (const tr of $$("#mvTable tbody tr[data-pt]")) tr.classList.toggle("active", tr.dataset.pt === state.active?.id);
  for (const inp of $$("[data-pt-time]")) {
    const [id, field] = inp.dataset.ptTime.split(":");
    inp.classList.toggle("active", !!ap && ap.pt.id === id && ap.field === field);
  }
  $("#moveSel").innerHTML = ap
    ? `선택: <b>${ptName(ap.pt)} · ${fieldLabel(ap.pt, ap.field)}</b> ${ap.pt[ap.field] != null ? fmtTime(ap.pt[ap.field]) : "(비어 있음)"} · ⏺ 현재를 누르면 지금 재생 시각이 들어갑니다`
    : "지점을 클릭해서 선택하세요";
}

const ptName = (pt) => (ptIndex(pt) === 0 ? "⌂ 첫 지점" : `지점 ${ptIndex(pt)}`);

// nearest path point on the floor being viewed
function hitPathPoint(p) {
  const tol = 12 * cssPx();
  let best = null, bd = tol;
  for (const q of state.path) {
    if (q.floor !== state.viewFloor) continue;
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < bd) { bd = d; best = q; }
  }
  return best;
}

// the leg (on this floor, straight or bent) under the pointer: {k} or null
function hitLeg(p) {
  const tol = 9 * cssPx();
  let best = null, bd = tol;
  for (const l of legs()) {
    if (l.a.floor !== state.viewFloor || l.b.floor !== state.viewFloor) continue;
    const poly = canBend(l) ? routePoly(l) : [[l.a.x, l.a.y], [l.b.x, l.b.y]];
    for (let i = 0; i < poly.length - 1; i++) {
      const d = segDist(p, poly[i], poly[i + 1]);
      if (d < bd) { bd = d; best = l; best.seg = i; }
    }
  }
  return best;
}

// a click near a room uses that exact spot
function snapPos(p) {
  const room = hitRoom(p);
  return room ? { floor: room.floor, x: room.x, y: room.y } : { floor: state.viewFloor, x: +p.x.toFixed(1), y: +p.y.toFixed(1) };
}

const newPoint = (p) => ({ id: "p" + Math.random().toString(36).slice(2, 8), ...snapPos(p), arrive: null, depart: null });

// click on an empty spot: a new point at the end of the path. The first point gets the current time as its
// departure, every other point as its arrival; the next box to fill (departure) becomes active, so
// "click the spot on arrival, scrub, ⏺ 현재 on leaving, click the next spot" is the whole rhythm.
function appendPoint(p) {
  const pt = newPoint(p);
  if (!state.path.length) { pt.depart = nowT(); flash(`⌂ 첫 지점 · 이동 시작 ${fmtTime(pt.depart)} (걷기 시작하는 순간에 ⏺ 현재)`); }
  else { pt.arrive = nowT(); flash(`지점 ${state.path.length} · 시작 ${fmtTime(pt.arrive)} · 떠나는 순간에 ⏺ 현재`); }
  state.path.push(pt);
  state.active = { id: pt.id, field: "depart" };
  saveRoomsMoves();
}

// click on a leg: a point in between (arrives now, leaves right away until you set it)
function insertPoint(p, k, seg = 0) {
  const pt = newPoint(p);
  pt.arrive = nowT();
  const next = state.path[k], prev = state.path[k - 1];
  state.path.splice(k, 0, pt);
  // the bends of the leg that was split stay where they are: the ones before the clicked piece now belong to the
  // leg into the new point, the rest to the leg out of it (a leg that could not be bent just loses its stale bends)
  const via = next.via || [];
  if (via.length && prev.floor === next.floor && next.mode !== "jump" && pt.floor === next.floor) {
    const head = via.slice(0, seg), tail = via.slice(seg);
    if (head.length) pt.via = head;
    if (tail.length) next.via = tail; else delete next.via;
  } else delete next.via;
  forgetRouteUndo(next.id);   // old snapshots hold the whole bend list for a leg that no longer exists
  state.active = { id: pt.id, field: "depart" };
  saveRoomsMoves();
  flash(`지점 ${k} 끼워 넣음 · 시작 ${fmtTime(pt.arrive)}`);
}

// ⏺ 현재: the active time box takes the playback time; after an arrival the departure box is next
function stampActive() {
  const ap = activePoint();
  if (!ap) { flash("먼저 도면이나 표에서 지점을 클릭해 선택하세요"); return; }
  ap.pt[ap.field] = nowT();
  flash(`${ptName(ap.pt)} ${fieldLabel(ap.pt, ap.field)} → ${fmtTime(nowT())}`);
  if (ap.field === "arrive") state.active = { id: ap.pt.id, field: "depart" };
  saveRoomsMoves();
}

function deletePoint(pt) {
  const i = ptIndex(pt);
  if (i < 0) return;
  state.path.splice(i, 1);
  if (i < state.path.length && i > 0) delete state.path[i].via;   // the leg that now reaches the next point is new
  if (state.path.length && i === 0) delete state.path[0].via;
  if (i < state.path.length) forgetRouteUndo(state.path[i].id);
  if (state.active?.id === pt.id) state.active = null;
  saveRoomsMoves();
  flash("지점 삭제");
}

$("#moveNowBtn").addEventListener("click", stampActive);
$("#moveDelBtn").addEventListener("click", () => {
  const pt = state.active && ptById(state.active.id);
  if (pt) deletePoint(pt); else flash("삭제할 지점을 먼저 선택하세요");
});

// what the server made of the leg into this point
const trackLeg = (pt) => state.track?.moves?.find((x) => x.id === pt.id);

// the leg into point k, as shown in the table: duration, kind, bends, warnings
function legInfo(pt) {
  const k = ptIndex(pt);
  if (k <= 0) return `<span class="muted">영상 시작부터 여기</span>`;
  const prev = state.path[k - 1];
  const bits = [];
  const start = prev.depart ?? (k > 1 ? prev.arrive : 0), end = pt.arrive;
  if (end == null) bits.push(`<span class="warn">⚠ 시작 시각 없음 (앞 지점을 떠나는 순간 바로 나타남)</span>`);
  else if (start != null && end < start) bits.push(`<span class="warn">⚠ 시작이 앞 지점 종료(${fmtTime(start)})보다 앞</span>`);
  else if (start != null) bits.push(`<span title="앞 지점 종료 ~ 이 지점 시작 사이로 속도가 자동으로 정해집니다">${(end - start).toFixed(1)}초 ${prev.floor !== pt.floor ? "층 이동 (순간이동)" : pt.mode === "jump" ? "순간이동" : "이동"}</span>`);
  const leg = legs()[k - 1];
  if (pt.via?.length && canBend(leg)) bits.push(`<span class="mvroute-row">↩ 꺾임 ${pt.via.length}<button data-pt-route-clear="${pt.id}" class="mvroute-clear" title="꺾은 점을 모두 지우고 직선으로 되돌립니다">초기화</button></span>`);
  return `<div class="mv">${bits.join(" · ")}</div>`;
}

// how long the marker rests here
function stayInfo(pt) {
  const k = ptIndex(pt), last = k === state.path.length - 1;
  if (pt.depart == null) return last ? "" : k === 0 ? `<span class="warn">⚠ 이동 시작 시각 없음 (영상 처음부터 바로 떠남)</span>` : `<span class="warn">⚠ 종료 시각 없음 (시작하자마자 떠남)</span>`;
  if (k === 0) return "";
  if (pt.arrive == null) return "";
  if (pt.depart < pt.arrive) return `<span class="warn">⚠ 종료가 시작보다 앞</span>`;
  return `머묾 ${(pt.depart - pt.arrive).toFixed(1)}초`;
}

function renderMoves() {
  $("#mvCount").textContent = state.path.length ? `지점 ${state.path.length}개 · 이동 ${Math.max(0, state.path.length - 1)}개` : "";
  const now = video.currentTime;
  const cur = state.track?.moves?.find((m) => m.end > m.start && now >= m.start && now <= m.end)?.id;
  const fl = (q) => escapeHtml(floorOf(q.floor)?.label || "");
  const box = (pt, field) => `<input class="mvtime ${isActiveField(pt, field) ? "active" : ""}" data-pt-time="${pt.id}:${field}" value="${pt[field] == null ? "" : fmtTime(pt[field])}" placeholder="분:초"
      title="${fieldLabel(pt, field)} 시각 (분:초 또는 초). 클릭하면 이 칸이 선택되어 ⏺ 현재로 시각을 넣을 수 있습니다" />`;
  $("#mvTable tbody").innerHTML = state.path.map((pt, i) => {
    const last = i === state.path.length - 1;
    return `
    <tr data-pt="${pt.id}" class="${isActivePoint(pt) ? "active" : ""} ${cur === pt.id ? "now" : ""}">
      <td><a href="#" data-pt-seek="${pt.id}" title="이 지점의 시각으로 이동">${i === 0 ? "⌂" : i}</a><div class="mv">${fl(pt)}</div></td>
      <td>${i === 0 ? `<span class="muted">영상 처음</span>` : box(pt, "arrive")}</td>
      <td>${i === 0 ? `<span class="muted">이동 시작</span> ` : ""}${box(pt, "depart")}<div class="mv">${last && pt.depart == null ? `<span class="muted">다음 지점을 찍으면 씀</span>` : stayInfo(pt)}</div></td>
      <td>${i > 0 && state.path[i - 1].floor === pt.floor ? `<select data-pt-mode="${pt.id}" class="mvmode" title="걸어서: 앞 지점에서 직선으로 걷습니다 (④ 경로 꺾기로 꺾을 수 있음) · 순간이동: 앞 지점에서 사라졌다 여기서 나타납니다 (영상이 컷으로 넘어갈 때)">
          <option value="walk" ${pt.mode !== "jump" ? "selected" : ""}>걸어서</option><option value="jump" ${pt.mode === "jump" ? "selected" : ""}>순간이동</option></select>` : ""}${legInfo(pt)}</td>
      <td>${i > 0 ? `<button data-pt-play="${pt.id}" title="앞 지점에서 여기까지의 이동만 재생해서 확인 (앞뒤 1초)">▶ 확인</button>` : ""}</td>
      <td><button data-pt-del="${pt.id}" title="이 지점 삭제 (앞뒤 지점이 바로 이어집니다)">✕</button></td>
    </tr>`; }).join("") || `<tr><td colspan="6" class="muted">③ 이동 지점 모드에서 도면을 클릭해 마커가 지나갈 지점을 차례로 찍으세요</td></tr>`;
  refreshActiveMarks();   // the "선택: …" line and the highlighted boxes follow a newly added point or a stamped time too
}

$("#mvTable").addEventListener("click", (e) => {
  const sk = e.target.closest("[data-pt-seek]");
  if (sk) {
    e.preventDefault();
    const pt = ptById(sk.dataset.ptSeek);
    if (!pt) return;
    setActive(pt, null);
    const t = ptIndex(pt) === 0 ? pt.depart : pt.arrive;
    if (t != null) { video.pause(); video.currentTime = t; }
    if (pt.floor !== state.viewFloor) showFloor(pt.floor);
  }
  const pl = e.target.closest("[data-pt-play]");
  if (pl) { const m = trackLeg(ptById(pl.dataset.ptPlay) || {}); if (m) playAround(m.start, 1, m.end); }
  const rc = e.target.closest("[data-pt-route-clear]");
  if (rc) { const pt = ptById(rc.dataset.ptRouteClear); if (pt) clearRoute(pt); }
  const d = e.target.closest("[data-pt-del]");
  if (d) { const pt = ptById(d.dataset.ptDel); if (pt) deletePoint(pt); }
});
$("#mvTable").addEventListener("change", (e) => {
  const md = e.target.closest("[data-pt-mode]");
  if (!md) return;
  const pt = ptById(md.dataset.ptMode);
  if (!pt) return;
  if (md.value === "jump") pt.mode = "jump"; else delete pt.mode;
  saveRoomsMoves();
});

// the time boxes (in the table and beside the selected point on the plan) select their field and edit its time
function bindTimeInputs(root) {
  root.addEventListener("focusin", (e) => {
    const inp = e.target.closest("[data-pt-time]");
    if (!inp) return;
    const [id, field] = inp.dataset.ptTime.split(":");
    const pt = ptById(id);
    if (pt && !isActiveField(pt, field)) setActive(pt, field);
  });
  root.addEventListener("change", (e) => {
    const inp = e.target.closest("[data-pt-time]");
    if (!inp) return;
    const [id, field] = inp.dataset.ptTime.split(":");
    const pt = ptById(id);
    if (!pt) return;
    const v = parseTime(inp.value);
    if (v == null && inp.value.trim()) {   // not a time: keep what was there and say so
      flash("시각은 분:초 또는 초로 적어 주세요 (예: 1:23.5)");
      inp.value = pt[field] == null ? "" : fmtTime(pt[field]);
      return;
    }
    pt[field] = v;
    saveRoomsMoves();
  });
  root.addEventListener("keydown", (e) => {
    if (!e.target.matches("[data-pt-time]")) return;
    if (e.key === "Enter" || e.key === "Escape") e.target.blur();
    else if (e.key === " ") { e.preventDefault(); e.target.blur(); video.paused ? video.play() : video.pause(); }
  });
}
bindTimeInputs($("#mvTable"));
bindTimeInputs($("#planLabels"));

function showFloor(fid) {
  state.viewFloor = fid;
  renderFloorTabs();
  resizePlan();
  drawPlan();
  if (state.mode === "draw") loadStruct();
}

// The time boxes beside the selected point on the plan (시작 / 종료). The element is kept and only moved /
// re-marked, so typing in it survives redraws (drawPlan runs on every tick while the video plays).
function syncPointLabels() {
  const box = $("#planLabels");
  const ap = activePoint();
  if (state.mode !== "moves" || !viewImg() || !ap || ap.pt.floor !== state.viewFloor) { if (box.childElementCount) box.innerHTML = ""; return; }
  const k = planCv.getBoundingClientRect().width / viewImg().width;
  const pt = ap.pt, fields = ptFields(pt);
  let el = box.firstElementChild;
  if (!el || el.dataset.pt !== pt.id || el.dataset.fields !== fields.join(",")) {
    box.innerHTML = "";
    el = document.createElement("div");
    el.className = "ptlabel";
    el.dataset.pt = pt.id;
    el.dataset.fields = fields.join(",");
    el.innerHTML = `<b class="ptname"></b>` + fields.map((f) =>
      `<label><span class="tag">${fieldLabel(pt, f)}</span><input data-pt-time="${pt.id}:${f}" placeholder="분:초" title="${fieldLabel(pt, f)} 시각 (분:초 또는 초) · Enter로 적용" /></label>`).join("");
    box.appendChild(el);
  }
  // right of the point, or left of it when that would run past the plan's edge
  const flip = pt.x * k + 14 + 190 > planCv.clientWidth;
  el.style.left = flip ? "" : `${pt.x * k + 14}px`;
  el.style.right = flip ? `${planCv.clientWidth - pt.x * k + 14}px` : "";
  el.style.top = `${pt.y * k}px`;
  el.querySelector(".ptname").textContent = ptName(pt);
  for (const inp of el.querySelectorAll("input")) {
    const f = inp.dataset.ptTime.split(":")[1];
    inp.classList.toggle("active", ap.field === f);
    if (document.activeElement !== inp) inp.value = pt[f] == null ? "" : fmtTime(pt[f]);
  }
}

// the path on the floor being viewed: legs with an arrow, points with their number, ⌂ for the first point
function drawMoves(ctx, u) {
  const fid = state.viewFloor;
  ctx.save();
  ctx.lineJoin = ctx.lineCap = "round";
  for (const l of legs()) {
    const a = l.a.floor === fid ? l.a : null, b = l.b.floor === fid ? l.b : null;
    if (!a && !b) continue;
    if (a && b) {
      // the route: straight, or through the bend points set in ④ 경로 꺾기 (a "순간이동" leg is dashed)
      const poly = canBend(l) ? routePoly(l) : [[a.x, a.y], [b.x, b.y]];
      ctx.strokeStyle = "#2563eb";
      ctx.lineWidth = 2.5 * u;
      if (!canBend(l)) ctx.setLineDash([6 * u, 5 * u]);
      ctx.beginPath();
      poly.forEach((q, k) => (k ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])));
      ctx.stroke();
      ctx.setLineDash([]);
      // arrow head mid-way along the longest straight piece, pointing towards the next point
      let seg = 0, best = -1;
      for (let k = 0; k < poly.length - 1; k++) {
        const d = Math.hypot(poly[k + 1][0] - poly[k][0], poly[k + 1][1] - poly[k][1]);
        if (d > best) { best = d; seg = k; }
      }
      const [p0, p1] = [poly[seg], poly[seg + 1]];
      const dx = p1[0] - p0[0], dy = p1[1] - p0[1], L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
      if (L > 30 * u) {
        const mx = p0[0] + dx * 0.55, my = p0[1] + dy * 0.55, s = 6 * u;
        ctx.fillStyle = "#2563eb";
        ctx.beginPath();
        ctx.moveTo(mx + ux * s, my + uy * s);
        ctx.lineTo(mx - ux * s - uy * s * 0.9, my - uy * s + ux * s * 0.9);
        ctx.lineTo(mx - ux * s + uy * s * 0.9, my - uy * s - ux * s * 0.9);
        ctx.closePath(); ctx.fill();
      }
    } else {   // the other end is on another floor: a short dashed stub says "continues elsewhere"
      const q = a || b;
      ctx.strokeStyle = "#2563eb"; ctx.lineWidth = 2 * u; ctx.setLineDash([4 * u, 4 * u]);
      ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.lineTo(q.x + (a ? 22 : -22) * u, q.y); ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  state.path.forEach((pt, i) => {
    if (pt.floor !== fid) return;
    const act = isActivePoint(pt), first = i === 0;
    const col = act ? "#ea580c" : first ? "#16a34a" : "#2563eb";
    ctx.lineWidth = 2.5 * u;
    ctx.strokeStyle = col;
    ctx.fillStyle = first ? "#fff" : col;
    ctx.beginPath(); ctx.arc(pt.x, pt.y, (first ? 10 : 8) * u, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = first ? col : "#fff";
    ctx.font = `bold ${(first ? 12 : 9.5) * u}px sans-serif`;
    ctx.fillText(first ? "⌂" : String(i), pt.x, pt.y + 0.5 * u);
    if (act) { ctx.lineWidth = 2 * u; ctx.beginPath(); ctx.arc(pt.x, pt.y, 14 * u, 0, Math.PI * 2); ctx.stroke(); }
  });
  ctx.restore();
}

// every point's arrival (■) and departure (▷) for the timeline (drag to retime, click to seek)
function movePoints() {
  const out = [];
  state.path.forEach((pt, i) => {
    if (i > 0 && pt.arrive != null) out.push({ t: pt.arrive, pt, field: "arrive" });
    if (pt.depart != null && (i < state.path.length - 1)) out.push({ t: pt.depart, pt, field: "depart" });
  });
  return out;
}

// ---------------- plan drawing tools ("도면 다듬기") ----------------
// Edits live on each floor as floor.edits = [{type: line|door|stairs|erase, ...}] in plan pixels.
// The server combines them with the automatically detected walls when it draws the minimap.

state.mode = "draw";   // the tabs follow the work order: tidy the plan, name the rooms, set the moves, bend them
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
  $("#moveBar").classList.toggle("hidden", mode !== "moves");
  if (mode === "moves") refreshActiveMarks();
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
  if (clear && n && !confirm(`${f.label}의 자동 인식 항목 ${n}개를 지울까요? 직접 그리거나 옮긴 것과 지우개 자국은 남습니다.`)) return;
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
  let last;
  while ((last = state.undo.pop()) && !floorOf(last.fid));   // entries of a deleted floor are skipped
  if (!last) return;
  floorOf(last.fid).edits = JSON.parse(last.edits);
  if (last.fid !== state.viewFloor) {   // the change being undone is on another floor: show it, or it looks like nothing happened
    state.selectedEdit = null;
    showFloor(last.fid);
    flash(`${floorOf(last.fid).label} 되돌리기`);
  }
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
  const over = p && hitEdit(p, SHAPE_TYPES, true);
  if (p && resizeGesture(e)) {   // resize: a handle under the pointer, or the nearest handle of the shape under it
    planCv.style.cursor = hitHandle(p) || hitEdit(p, SHAPE_TYPES, true) ? "nwse-resize" : "crosshair";
    return;
  }
  if (p && manipTool() && !e.ctrlKey && !e.metaKey) {   // over the selected item: handle = resize, body = move
    const m = manipTarget(p);
    if (m) { planCv.style.cursor = m.h ? "nwse-resize" : "grab"; return; }
  }
  planCv.style.cursor = state.tool === "copy" ? (over ? "copy" : "crosshair")
    : (e.ctrlKey || e.metaKey) && over ? "grab" : "crosshair";
}

// ---- direct manipulation: a click selects an item; only the selected item can then be dragged (move) or
// pulled by its handles (resize), so drawing over other shapes never disturbs them ----

const manipTool = () => !["erase", "flip", "copy", "delete", "resize"].includes(state.tool);

// the selected drawn item (a plain click on a shape, or Ctrl+click on anything): Del removes it
function selectEdit(e) {
  state.selectedEdit = e || null;
  drawPlan();
}

function deleteSelectedEdit() {
  const e = state.selectedEdit;
  const list = e && curEdits();
  if (!list || !list.includes(e)) { state.selectedEdit = null; flash("먼저 도형을 클릭해서 선택하세요"); return; }
  pushUndo();
  list.splice(list.indexOf(e), 1);
  state.selectedEdit = null;
  saveEdits(e.type === "erase");
  flash("도형 삭제 · Ctrl+Z로 되돌리기");
}

// Ctrl+C keeps a copy of the selected item; Ctrl+V puts it under the pointer (or beside the original)
function copySelectedEdit() {
  const e = state.selectedEdit;
  if (!e || !curEdits().includes(e)) { flash("먼저 도형을 클릭해서 선택하세요"); return; }
  state.clipboard = JSON.stringify(e);
  state.pasteCount = 0;
  flash("복사됨 · Ctrl+V로 붙여넣기 (마우스 위치에)");
}

function editCenter(e) {
  const pts = editSegments(e).flat();
  const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
}

function pasteEdit() {
  if (!state.clipboard) { flash("복사한 도형이 없습니다 (도형 선택 후 Ctrl+C)"); return; }
  const c = JSON.parse(state.clipboard);
  delete c.auto;   // a paste counts as hand-drawn even when the original was automatic
  const at = state.hover;
  const ctr = editCenter(c);
  if (at) translateEdit(c, at.x - ctr.x, at.y - ctr.y);
  else { const k = 12 * cssPx() * ++state.pasteCount; translateEdit(c, k, k); }
  pushUndo();
  curEdits().push(c);
  state.selectedEdit = c;
  saveEdits();
  flash(at ? "붙여넣기" : "붙여넣기 (원본 옆에)");
}

// the selected item under the pointer: {e, h} on one of its handles, {e} on its body, or null
function manipTarget(p) {
  const e = state.selectedEdit;
  if (!e || !curEdits().includes(e) || e.type === "erase") return null;
  const tol = 10 * cssPx();
  let best = null, bd = tol;
  for (const h of editHandles(e)) {
    const d = Math.hypot(h.pt[0] - p.x, h.pt[1] - p.y);
    if (d < bd) { bd = d; best = h; }
  }
  if (best) return { e, h: best };
  let d = Math.min(...editSegments(e).map(([a, b]) => segDist(p, a, b)));
  if (e.type === "door") {
    const r = Math.hypot(e.end[0] - e.hinge[0], e.end[1] - e.hinge[1]);
    d = Math.min(d, Math.abs(Math.hypot(p.x - e.hinge[0], p.y - e.hinge[1]) - r));
  }
  return insideEdit(e, p) || d < 8 * cssPx() ? { e } : null;
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
function hitHandle(p, tol = 10 * cssPx(), types = SHAPE_TYPES) {
  let best = null, bd = tol;
  for (const e of curEdits()) {
    if (!types.includes(e.type)) continue;
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
  if (manipTool() && !e.ctrlKey && !e.metaKey && !resizeGesture(e)) {   // the selected item: handle resizes, body moves
    const m = manipTarget(p);
    if (m?.h) { startResize(p, m); return; }
    if (m) { startMove(p, m.e, false); return; }
  }
  state.selectedEdit = null;   // set again on a plain click (drawUp) or when a new item is drawn
  if (e.ctrlKey || e.metaKey) {   // Ctrl+drag moves, Ctrl+Shift+drag drags a copy
    const hit = hitEdit(p, SHAPE_TYPES, true);   // never an eraser stroke: those are invisible outside the delete tool
    if (hit) startMove(p, hit, e.shiftKey);
    return;
  }
  if (resizeGesture(e)) {   // resize tool, or Shift+drag with any tool
    const target = resizeTarget(p);
    if (target) { startResize(p, target); return; }
    if (t === "resize") return;   // Shift over empty space with another tool: draw as usual
  }
  if (t === "copy") {
    const hit = hitEdit(p, SHAPE_TYPES, true);
    if (hit) startMove(p, hit, true);
    return;
  }
  if (t === "delete") {
    const hit = hitEdit(p);
    if (hit) { pushUndo(); curEdits().splice(curEdits().indexOf(hit), 1); saveEdits(hit.type === "erase"); }
    return;
  }
  if (t === "flip") {   // the flip tool: a click on a door / toilet / stairs flips it
    const hit = hitEdit(p, FLIPPABLE, true);
    if (hit) state.drawing = { type: "flip", target: hit, start: p };
    return;
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
  if (!d) { moveCursor(e, p); if (state.tool === "erase" || resizeGesture(e) || manipTool()) drawPlan(); return; }
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
  if (d.type === "erase") {
    const q = d.pts[d.pts.length - 1];
    if (Math.hypot(p.x - q[0], p.y - q[1]) >= Math.max(1, d.r / 3)) d.pts.push([p.x, p.y]);   // the stroke is 2r wide: closer points change nothing
  }
  else if (d.type === "line" || d.type === "thinline") [d.start, d.end] = clipToWalls(d.start0, snapPoint(p, d.start0, e.altKey));
  else if (d.type !== "flip") d.end = p;
  drawPlan();
}

function drawUp() {
  const d = state.drawing;
  state.drawing = null;
  if (!d) return;
  if (d.type === "resize") {
    state.selectedEdit = d.target;
    if (d.moved) { delete d.target.auto; saveEdits(); }
    else { state.undo.pop(); drawPlan(); }
    return;
  }
  if (d.type === "move") {
    planCv.style.cursor = state.tool === "copy" ? "copy" : "grab";
    if (d.moved) { delete d.target.auto; saveEdits(d.target.type === "erase"); }
    else if (d.copy) {   // a plain click: put the copy just beside the original so it is visible
      translateEdit(d.target, 12 * cssPx(), 12 * cssPx());
      saveEdits(d.target.type === "erase");
      flash("복사됨 · Ctrl+드래그로 옮기세요");
    } else { state.undo.pop(); }
    state.selectedEdit = d.target;   // a plain click selects the shape (Del deletes it); a drag keeps it selected
    drawPlan();
    return;
  }
  const len = d.start && d.end ? Math.hypot(d.end.x - d.start.x, d.end.y - d.start.y) : 0;
  const min = 4 * cssPx();
  pushUndo();
  if (d.type === "flip") { flipEdit(d.target); delete d.target.auto; state.selectedEdit = d.target; }
  else if (d.type === "erase") curEdits().push({ type: "erase", pts: d.pts, r: d.r });
  else if (len < min) {   // a plain click, no drag: select the item under it (lines included) instead of drawing
    state.undo.pop();
    state.selectedEdit = hitEdit(d.start0 || d.start, SHAPE_TYPES, true);
    drawPlan();
    return;
  }
  else if (d.type === "line") curEdits().push({ type: "line", pts: [[d.start.x, d.start.y], [d.end.x, d.end.y]] });
  else if (d.type === "door") curEdits().push({ type: "door", hinge: [d.start.x, d.start.y], end: [d.end.x, d.end.y], flip: false });
  else if (d.type === "stairs") curEdits().push({ type: "stairs", a: [d.start.x, d.start.y], b: [d.end.x, d.end.y] });
  else if (d.type === "thinline") curEdits().push({ type: "line", pts: [[d.start.x, d.start.y], [d.end.x, d.end.y]], thin: true });
  else curEdits().push({ ...previewShape(d), thin: $("#shapesThin").checked });  // toilet / rect / circle / fixtures
  // a new shape is selected so it can be moved / resized right away. Not a new line: walls are drawn in chains, and a
  // selected line's endpoint handle would turn the next stroke from that endpoint into a resize. A flip keeps its target.
  if (!["erase", "flip", "line", "thinline"].includes(d.type)) state.selectedEdit = curEdits()[curEdits().length - 1];
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
  const sel = state.selectedEdit;
  if (sel && curEdits().includes(sel) && !d) {   // the selected item: thicker blue outline + its handles
    ctx.save();
    ctx.strokeStyle = "rgba(37, 99, 235, .35)";
    ctx.lineWidth = 9 * u;
    ctx.lineCap = ctx.lineJoin = "round";
    for (const [a, b] of editSegments(sel)) { ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); }
    ctx.restore();
    if (SHAPE_TYPES.includes(sel.type)) drawHandles(ctx, sel, u);
  }
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

  syncPointLabels();
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
  if (state.mode === "moves" || state.mode === "route") drawMoves(ctx, u);
  if (state.mode === "route") {
    for (const ev of bendableMoves()) {
      for (const q of ev.b.via || []) {   // bends live on the point the leg goes INTO (leg.b), not on the leg
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

  // a room is only a label: its name sits exactly on the clicked spot, as in the minimap
  state.rooms.forEach((r, i) => {
    if (r.floor !== state.viewFloor) return;
    const col = roomColor(r);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `bold ${13 * u}px sans-serif`;
    ctx.lineWidth = 4 * u;
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(255,255,255,.92)";
    ctx.strokeText(r.name || "(이름 없음)", r.x, r.y);
    ctx.fillStyle = col;
    ctx.fillText(r.name || "(이름 없음)", r.x, r.y);
    // the row number from the room table, as a small badge on the left
    const w = ctx.measureText(r.name || "(이름 없음)").width;
    ctx.beginPath();
    ctx.arc(r.x - w / 2 - 9 * u, r.y, 6.5 * u, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = `bold ${9 * u}px sans-serif`;
    ctx.fillText(String(i + 1), r.x - w / 2 - 9 * u, r.y + 0.5 * u);
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

  // the middle band: only the move strips and the record / point ticks live here (no per-room colouring)
  const bandY = 16 * dpr, bandH = 26 * dpr;

  if (state.analysis) {
    ctx.fillStyle = "#f59e0b";
    for (const sg of state.analysis.suggestions) ctx.fillRect(X(sg.t) - 1.5 * dpr, 0, 3 * dpr, 10 * dpr);
  }
  // each floor's show window as a thin strip just above the bands (grey = plan hidden there)
  const sy = 11 * dpr, sh = 4 * dpr;
  ctx.fillStyle = "rgba(120,120,120,.25)";
  ctx.fillRect(0, sy, W, sh);
  state.proj.floors.forEach((f, i) => {
    for (const w of floorShows(f)) {
      const x0 = X(w.start ?? 0), x1 = X(Math.min(w.end ?? dur, dur));
      ctx.fillStyle = i % 2 ? "rgba(139, 92, 246, .8)" : "rgba(16, 185, 129, .8)";
      ctx.fillRect(x0, sy, Math.max(x1 - x0, dpr), sh);
    }
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
  // ③ the path: ▷ where the marker departs a point, ■ where it arrives (orange = the selected box)
  for (const q of movePoints()) {
    const x = X(q.t), y = bandY + bandH + 8 * dpr, r = 5 * dpr;
    const col = isActiveField(q.pt, q.field) ? "#ea580c" : "#2563eb";
    ctx.fillStyle = col;
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    if (q.field === "depart") {
      ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x - r, y + r); ctx.closePath();
      ctx.fillStyle = "#fff"; ctx.fill(); ctx.stroke();
      ctx.fillStyle = col;
    } else {
      ctx.rect(x - r + dpr, y - r + dpr, 2 * r - 2 * dpr, 2 * r - 2 * dpr); ctx.fill();
    }
    ctx.fillRect(x - 0.5 * dpr, bandY, 1 * dpr, bandH);
  }
  ctx.fillStyle = "#111";
  ctx.fillRect(X(video.currentTime) - dpr, 0, 2 * dpr, H);
}

function timelineTime(e) {
  // the canvas is drawn over the content box (clientWidth), so the border must not count
  const b = timeline.getBoundingClientRect();
  const r = { left: b.left + timeline.clientLeft, width: timeline.clientWidth || b.width };
  return { t: Math.max(0, Math.min(state.proj.video.duration, ((e.clientX - r.left) / r.width) * state.proj.video.duration)), r };
}

function nearest(list, t, r, px = 7) {
  const dur = state.proj.video.duration;
  return list.find((x) => Math.abs(((x.t - t) / dur) * r.width) < px);
}

timeline.addEventListener("pointerdown", (e) => {
  if (!state.proj || e.button !== 0) return;
  const { t, r } = timelineTime(e);
  const mp = nearest(movePoints(), t, r);
  if (mp) {
    timeline.setPointerCapture(e.pointerId);
    state.tlDrag = { mp, moved: false, x0: e.clientX };
    setActive(mp.pt, mp.field);
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
    if (!d.moved && Math.abs(e.clientX - d.x0) < 4) return;   // a click on a mark only selects it; a hand tremor must not retime it
    d.moved = true;
    d.mp.pt[d.mp.field] = +t.toFixed(2);
    drawPlan();
    video.currentTime = t;
    drawTimeline();
    return;
  }
  const mp = nearest(movePoints(), t, r);
  const sug = state.analysis && nearest(state.analysis.suggestions, t, r);
  const mv = state.track?.moves?.find((m) => m.end > m.start && t >= m.start && t <= m.end);
  const win = state.proj.floors.flatMap((f) => floorShows(f)
    .map((w) => `${f.label} 도면 ${w.start != null ? fmtTime(w.start) : "처음"} ~ ${w.end != null ? fmtTime(w.end) : "끝"}`)).join(" · ");
  timeline.style.cursor = mp ? "ew-resize" : "pointer";
  timeline.title = mp ? `${ptName(mp.pt)} ${fieldLabel(mp.pt, mp.field)} ${fmtTime(mp.t)} (드래그로 조정)`
    : sug ? `${fmtTime(sug.t)} · AI 추천: ${sug.reason}`
    : mv ? `${mv.kind === "fade" ? "순간이동" : "이동"} ${fmtTime(mv.start)} → ${fmtTime(mv.end)} (${(mv.end - mv.start).toFixed(1)}초)`
    : win ? `${fmtTime(t)} · ${win}` : fmtTime(t);
});

timeline.addEventListener("pointerup", () => {
  const d = state.tlDrag;
  state.tlDrag = null;
  if (!d) return;
  if (d.moved) saveRoomsMoves();
  else video.currentTime = d.mp.t;
});
timeline.addEventListener("pointercancel", () => {   // touch / pen drag taken over by the browser: end it, keep what was moved
  const d = state.tlDrag;
  state.tlDrag = null;
  if (d?.moved) saveRoomsMoves();
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
function playAround(t, pad = 1.5, until = null) {
  const dur = state.proj.video.duration;
  clipStop = Math.min(dur, (until ?? t) + pad);
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

let lastMoveKey = "";
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
  const now = video.currentTime;
  const key = state.track?.moves?.find((m) => m.end > m.start && now >= m.start && now <= m.end)?.id || "";
  if (key !== lastMoveKey && !$("#mvTable").contains(document.activeElement)) {   // don't pull a time box out from under the typist
    lastMoveKey = key;
    renderMoves();
  }
}

function loop() {
  if (clipStop !== null && video.currentTime >= clipStop) video.pause();
  if (video.paused) return;
  tick();
  requestAnimationFrame(loop);
}

const TOOL_KEYS = { KeyL: "line", KeyT: "thinline", KeyD: "door", KeyS: "stairs", KeyB: "toilet", KeyR: "rect", KeyC: "circle",
  KeyW: "basin", KeyK: "sink", KeyI: "induction", KeyO: "closet", KeyF: "flip", KeyA: "resize", KeyE: "erase", KeyX: "delete" };

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
    if ((e.ctrlKey || e.metaKey) && e.code === "KeyC") { e.preventDefault(); copySelectedEdit(); return; }
    if ((e.ctrlKey || e.metaKey) && e.code === "KeyV") { e.preventDefault(); pasteEdit(); return; }
    if (TOOL_KEYS[e.code] && !e.ctrlKey && !e.metaKey) { setTool(TOOL_KEYS[e.code]); return; }
    if (e.code === "BracketLeft" || e.code === "BracketRight") {   // [ / ] = smaller / bigger eraser
      const inp = $("#eraseSize");
      inp.value = Math.max(+inp.min, Math.min(+inp.max, +inp.value + (e.code === "BracketRight" ? 3 : -3)));
      flash(`지우개 크기 ${inp.value}`);
      if (state.tool !== "erase") setTool("erase");
      drawPlan();
      return;
    }
    if (e.code === "Delete" || e.code === "Backspace") { e.preventDefault(); deleteSelectedEdit(); return; }
    if (e.code === "Escape") { selectEdit(null); return; }
  } else if ((e.ctrlKey || e.metaKey) && e.code === "KeyZ") {   // outside ①: undo route bending (also the 초기화 button)
    e.preventDefault();
    undoRoute();
    return;
  }
  if (e.code === "Space") { e.preventDefault(); video.paused ? video.play() : video.pause(); }
  else if (e.code === "ArrowLeft") { e.preventDefault(); if (e.ctrlKey || e.metaKey) stepFrame(-1); else video.currentTime -= e.shiftKey ? 1 : 10; }
  else if (e.code === "ArrowRight") { e.preventDefault(); if (e.ctrlKey || e.metaKey) stepFrame(1); else video.currentTime += e.shiftKey ? 1 : 10; }
  else if ((e.code === "Delete" || e.code === "Backspace") && state.mode === "moves") {
    const pt = state.active && ptById(state.active.id);
    if (pt) deletePoint(pt);
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
  const pid = state.proj.id;
  try {
    const { job } = await api(`/api/projects/${pid}/analyze`, { method: "POST" });
    await pollJob(job, (j) => (msg.textContent = `분석 중… ${Math.round(j.progress * 100)}%`));
    if (state.proj?.id !== pid) return;   // the user left this project meanwhile
    state.analysis = await api(`/api/projects/${pid}/analysis`);
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
  const pid = state.proj.id;
  try {
    await flushSaves();
    const { job } = await api(`/api/projects/${pid}/render`, { method: "POST", body: JSON.stringify({ outputs }) });
    const done = await pollJob(job, (j) => { prog.value = j.progress; msg.textContent = j.message || "렌더링 중…"; });
    if (state.proj?.id !== pid) return;   // the user left this project meanwhile
    msg.textContent = "완료!";
    const proj = await api(`/api/projects/${pid}`);
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
  const r = Math.round(t * 100) / 100;   // round first, so 59.996 becomes 1:00.00 rather than 0:60.00
  const m = Math.floor(r / 60), s = r - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}
function escapeHtml(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]); }
function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

// ---------------- boot ----------------

refreshPresets();
route();
