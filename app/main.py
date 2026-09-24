"""House-Map web server: upload video + floor plans, mark room changes, render minimap video."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .motion import analyze_video
from .render import (FFMPEG, DEFAULT_SETTINGS, FIXTURE_TYPES, auto_kinds, auto_trim, build_preview, decode_plan, imwrite,
                     load_plan, show_windows, merged_settings, render_outputs, rooms_by_floor, structure_alpha)
from .track import compute_track, plan_only_track
from .vectorize import AUTO_KINDS, auto_edits

ROOT = Path(__file__).resolve().parent.parent
DATA_ROOT = Path(os.environ.get("HOUSEMAP_DATA", ROOT / "data"))  # tests point this elsewhere
DATA = DATA_ROOT / "projects"
DATA.mkdir(parents=True, exist_ok=True)
PRESETS = DATA_ROOT / "presets.json"
# per-project data that a style preset must not carry over
NOT_STYLE = {"title", "hfov"}

app = FastAPI(title="House-Map")
executor = ThreadPoolExecutor(max_workers=2)
jobs: dict[str, dict] = {}
_lock = threading.Lock()

OUTPUT_EXTS = (".mp4", ".mov", ".png")


# ---------- storage helpers ----------

def pdir(pid: str) -> Path:
    d = DATA / pid
    if not pid.isalnum() or not d.is_dir():
        raise HTTPException(404, "프로젝트가 없습니다")
    return d


def load_project(pid: str) -> dict:
    return json.loads((pdir(pid) / "project.json").read_text("utf-8"))


def save_project(pid: str, proj: dict) -> None:
    path = pdir(pid) / "project.json"
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(proj, ensure_ascii=False, indent=2), "utf-8")
    tmp.replace(path)


def load_analysis(pid: str) -> dict | None:
    f = pdir(pid) / "analysis.json"
    return json.loads(f.read_text("utf-8")) if f.exists() else None


def probe_video(path: Path) -> dict:
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise HTTPException(400, "지원하지 않는 영상 형식입니다")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    ok, frame = cap.read()
    cap.release()
    if not ok:
        raise HTTPException(400, "영상 프레임을 읽을 수 없습니다")
    h, w = frame.shape[:2]
    return {"fps": fps, "frames": frames, "width": w, "height": h, "duration": frames / fps}


def save_plan_upload(d: Path, upload: UploadFile, fid: str, settings: dict) -> dict:
    img = cv2.imdecode(np.frombuffer(upload.file.read(), np.uint8), cv2.IMREAD_UNCHANGED)
    if img is None:
        raise HTTPException(400, f"도면은 PNG/JPG 이미지로 올려주세요 ({upload.filename})")
    trimmed = auto_trim(decode_plan(img))
    name = f"plan_{fid}.png"
    imwrite(d / name, trimmed)
    return {"id": fid, "file": name, "width": int(trimmed.shape[1]), "height": int(trimmed.shape[0]),
            "edits": detect_edits(trimmed, settings)}


def detect_edits(plan: np.ndarray, settings: dict, kinds=None) -> list[dict]:
    """Automatic walls / thin lines / doors / stairs as vector edits; a detection failure must not block an upload."""
    kinds = auto_kinds(settings) if kinds is None else kinds
    try:
        return auto_edits(plan, merged_settings(settings), kinds)
    except Exception as e:  # pragma: no cover - defensive
        print(f"auto detection failed: {e!r}")
        return []


def title_of(proj: dict) -> str:
    s = merged_settings(proj.get("settings"))
    return s["title"] or f"{proj.get('name', '')} mini map".strip()


def floors_for_render(d: Path, proj: dict) -> list[dict]:
    return [{"id": f["id"], "label": f["label"], "path": d / f["file"], "edits": f.get("edits", []),
             "show_start": f.get("show_start"), "show_end": f.get("show_end")} for f in proj["floors"]]


def public_project(pid: str) -> dict:
    proj = load_project(pid)
    d = pdir(pid)
    proj["id"] = pid
    proj.setdefault("moves", [])
    proj["settings"] = merged_settings(proj.get("settings"))
    proj["default_title"] = f"{proj.get('name', '')} mini map".strip()
    proj["has_preview"] = (d / "preview.mp4").exists()
    proj["has_analysis"] = (d / "analysis.json").exists()
    out = d / "outputs"
    proj["outputs"] = sorted(p.name for p in out.glob("*") if p.suffix in OUTPUT_EXTS) if out.exists() else []
    return proj


# ---------- jobs ----------

def start_job(pid: str, kind: str, fn) -> str:
    jid = uuid.uuid4().hex[:12]
    job = {"id": jid, "project": pid, "kind": kind, "status": "queued", "progress": 0.0, "message": "", "started": time.time()}
    with _lock:
        jobs[jid] = job

    def update(p: float, msg: str = "") -> None:
        job["progress"] = round(float(p), 3)
        if msg:
            job["message"] = msg

    def run() -> None:
        job["status"] = "running"
        try:
            job["result"] = fn(update)
            job["status"], job["progress"] = "done", 1.0
        except Exception as e:  # surface to the UI
            job["status"], job["message"] = "error", str(e)

    executor.submit(run)
    return jid


def make_preview(pid: str, update) -> None:
    """Browser-friendly H.264 proxy (phones often record HEVC which Chrome can't play)."""
    d = pdir(pid)
    src = d / load_project(pid)["video"]["file"]
    tmp = d / "preview.tmp.mp4"
    subprocess.run(
        [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", str(src),
         "-vf", "scale=-2:'min(720,ih)'", "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
         "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(tmp)],
        check=True,
    )
    tmp.replace(d / "preview.mp4")


# ---------- API ----------

@app.get("/")
def index():
    return RedirectResponse("/static/index.html")


@app.get("/api/defaults")
def defaults():
    return DEFAULT_SETTINGS


@app.get("/api/projects")
def list_projects():
    items = []
    for d in DATA.iterdir():
        f = d / "project.json"
        if not f.exists():
            continue
        p = json.loads(f.read_text("utf-8"))
        out = d / "outputs"
        outputs = sorted(x.name for x in out.glob("*") if x.suffix in OUTPUT_EXTS) if out.exists() else []
        minimap = next((o for o in outputs if o.startswith("minimap_")), None)
        floors = p.get("floors", [])
        items.append({
            "id": d.name,
            "name": p.get("name"),
            "created": p.get("created"),
            "updated": time.strftime("%Y-%m-%d %H:%M", time.localtime(f.stat().st_mtime)),
            "_mtime": f.stat().st_mtime,
            "duration": p.get("video", {}).get("duration", 0),
            "floors": [fl.get("label", "") for fl in floors],
            "rooms": len(p.get("rooms", [])),
            "moves": len(p.get("moves", [])),
            "outputs": outputs,
            # styled minimap if it has been rendered, else the raw plan
            "thumb": f"outputs/{minimap}" if minimap else (floors[0]["file"] if floors else None),
            "size": sum(x.stat().st_size for x in d.rglob("*") if x.is_file()),
        })
    items.sort(key=lambda i: i.pop("_mtime"), reverse=True)
    return items


@app.post("/api/projects")
def create_project(
    video: UploadFile = File(...),
    plans: list[UploadFile] = File(...),
    name: str = Form(""),
    labels: str = Form(""),
    preset: str = Form(""),
):
    pid = uuid.uuid4().hex[:10]
    d = DATA / pid
    d.mkdir(parents=True)
    try:
        ext = Path(video.filename or "video.mp4").suffix.lower() or ".mp4"
        vpath = d / f"video{ext}"
        with vpath.open("wb") as f:
            shutil.copyfileobj(video.file, f, length=8 << 20)
        info = probe_video(vpath)

        settings = merged_settings(load_presets().get(preset))
        given = [s.strip() for s in labels.split(",")] if labels else []
        floors = []
        for i, up in enumerate(plans):
            fl = save_plan_upload(d, up, f"f{i + 1}", settings)
            fl["label"] = given[i] if i < len(given) and given[i] else f"{i + 1}F"
            floors.append(fl)

        proj = {
            "name": name or Path(video.filename or "영상").stem,
            "created": time.strftime("%Y-%m-%d %H:%M:%S"),
            "video": {"file": vpath.name, "original_name": video.filename, **info},
            "floors": floors,
            "rooms": [],
            "moves": [],
            "settings": settings,
        }
        (d / "project.json").write_text(json.dumps(proj, ensure_ascii=False, indent=2), "utf-8")
    except Exception:
        shutil.rmtree(d, ignore_errors=True)
        raise
    preview_job = start_job(pid, "preview", lambda up: make_preview(pid, up))
    return {**public_project(pid), "preview_job": preview_job}


@app.get("/api/projects/{pid}")
def get_project(pid: str):
    return public_project(pid)


class ProjectUpdate(BaseModel):
    name: str | None = None
    floors: list[dict] | None = None     # labels, order and drawing edits are editable here
    rooms: list[dict] | None = None
    moves: list[dict] | None = None      # "③ 이동 지점": start/end points with their own times, bends, mode
    settings: dict | None = None


def clean_moves(moves: list[dict], floor_ids: set[str]) -> list[dict]:
    """Moves as stored: {id, a: {floor, x, y}, b: {floor, x, y} | None, t0, t1, via?, mode?}. A move whose end
    point is not placed yet (b = None) is kept so it survives a reload; the track ignores it until it is complete.
    "via" = bend points (plan px) the walk passes through in order (④ 경로 꺾기); mode "jump" = fade instead of walking."""
    def point(p):
        if p is None:
            return None
        if p["floor"] not in floor_ids:
            raise ValueError("floor")
        return {"floor": p["floor"], "x": round(float(p["x"]), 1), "y": round(float(p["y"]), 1)}

    def when(v):
        return None if v in (None, "") else round(max(0.0, float(v)), 3)

    out = []
    try:
        for m in moves:
            a = point(m.get("a"))
            if a is None:
                continue
            via = [[round(float(q[0]), 1), round(float(q[1]), 1)] for q in (m.get("via") or [])[:30]]
            out.append({"id": str(m.get("id") or uuid.uuid4().hex[:6]), "a": a, "b": point(m.get("b")),
                        "t0": when(m.get("t0")), "t1": when(m.get("t1")),
                        **({"via": via} if via else {}), **({"mode": "jump"} if m.get("mode") == "jump" else {})})
    except (KeyError, TypeError, ValueError):
        raise HTTPException(400, "잘못된 이동 지점입니다")
    out.sort(key=lambda m: (m["t0"] is None, m["t0"] or 0.0))
    return out


@app.put("/api/projects/{pid}")
def update_project(pid: str, body: ProjectUpdate):
    proj = load_project(pid)
    if body.name is not None:
        proj["name"] = body.name
    if body.floors is not None:
        by_id = {f["id"]: f for f in proj["floors"]}

        def show_time(f, key):
            # when this floor's plan appears / disappears (seconds); None = video edge
            v = f.get(key, by_id[f["id"]].get(key)) if key in f else by_id[f["id"]].get(key)
            if v in (None, ""):
                return None
            try:
                return round(max(0.0, float(v)), 2)
            except (TypeError, ValueError):
                raise HTTPException(400, "도면 노출 시각이 잘못되었습니다")

        proj["floors"] = [{**by_id[f["id"]], "label": str(f.get("label", by_id[f["id"]]["label"])),
                           "edits": clean_edits(f["edits"]) if "edits" in f else by_id[f["id"]].get("edits", []),
                           "show_start": show_time(f, "show_start"), "show_end": show_time(f, "show_end")}
                          for f in body.floors if f.get("id") in by_id]
    floor_ids = {f["id"] for f in proj["floors"]}
    if body.rooms is not None:
        rooms = []
        for r in body.rooms:
            try:
                if r["floor"] not in floor_ids:
                    continue
                rooms.append({"id": str(r["id"]), "name": str(r.get("name", "")), "floor": r["floor"],
                              "x": round(float(r["x"]), 1), "y": round(float(r["y"]), 1)})
            except (KeyError, TypeError, ValueError):
                raise HTTPException(400, f"잘못된 방 정보: {r}")
        proj["rooms"] = rooms
    if body.moves is not None:
        proj["moves"] = clean_moves(body.moves, floor_ids)
    proj["moves"] = [m for m in proj.get("moves", [])
                     if m["a"]["floor"] in floor_ids and (m.get("b") is None or m["b"]["floor"] in floor_ids)]
    if body.settings is not None:
        proj["settings"] = merged_settings({**proj.get("settings", {}), **body.settings})
    save_project(pid, proj)
    return public_project(pid)


def clean_edits(edits) -> list[dict]:
    """Validate drawing edits: line / door / stairs / rect / circle / toilet / fixtures / erase, all in plan-pixel
    coordinates. "auto": true marks items the automatic detection made (the eraser and "다시 인식" act on those)."""
    def pt(v):
        return [round(float(v[0]), 1), round(float(v[1]), 1)]

    out = []
    try:
        for e in edits or []:
            t = e.get("type")
            if t == "line":
                out.append({"type": t, "pts": [pt(v) for v in e["pts"]][:200]})
            elif t in ("rect", "toilet", *FIXTURE_TYPES):
                out.append({"type": t, "a": pt(e["a"]), "b": pt(e["b"])})
            elif t == "circle":
                out.append({"type": t, "c": pt(e["c"]), "r": round(float(e["r"]), 1)})
            elif t == "door":
                out.append({"type": t, "hinge": pt(e["hinge"]), "end": pt(e["end"]), "flip": bool(e.get("flip"))})
            elif t == "stairs":
                item = {"type": t, "a": pt(e["a"]), "b": pt(e["b"]), "flip": bool(e.get("flip"))}
                if e.get("steps"):
                    item["steps"] = int(e["steps"])
                out.append(item)
            elif t == "erase":
                out.append({"type": t, "pts": [pt(v) for v in e["pts"]][:2000], "r": round(float(e.get("r", 6)), 1)})
            else:
                continue
            if t != "erase" and e.get("thin"):
                out[-1]["thin"] = True
            if e.get("auto"):
                out[-1]["auto"] = True
    except (KeyError, TypeError, ValueError, IndexError):
        raise HTTPException(400, "잘못된 도면 편집 데이터입니다")
    return out


@app.get("/api/projects/{pid}/structure/{fid}.png")
def get_structure(pid: str, fid: str):
    """Automatically detected lines (after eraser strokes) over the whole plan, for the plan editor."""
    d = pdir(pid)
    proj = load_project(pid)
    fl = next((f for f in proj["floors"] if f["id"] == fid), None)
    if not fl:
        raise HTTPException(404, "층이 없습니다")
    plan = load_plan(d / fl["file"])
    ph, pw = plan.shape[:2]
    k = max(1.0, 900 / max(pw, ph))  # small plans get a sharper overlay
    iw, ih = round(pw * k), round(ph * k)
    s = merged_settings(proj.get("settings"))
    a = structure_alpha(plan, s, fl.get("edits", []), (0, 0, pw, ph), iw, ih, 2.0, with_vectors=False)
    rgba = np.zeros((ih, iw, 4), np.uint8)
    rgba[..., :3] = (40, 40, 220)  # red-ish (BGR) so it stands out over any plan
    rgba[..., 3] = (a * 255).astype(np.uint8)
    ok, buf = cv2.imencode(".png", rgba)
    return Response(buf.tobytes(), media_type="image/png", headers={"Cache-Control": "no-store"})


class AutoBody(BaseModel):
    kinds: list[str] | None = None   # None = the project's auto_* settings; [] = remove the automatic items


@app.post("/api/projects/{pid}/floors/{fid}/auto")
def redetect_floor(pid: str, fid: str, body: AutoBody):
    """Run the automatic detection again for one floor: automatic items are replaced, hand-drawn ones and
    eraser strokes stay."""
    d = pdir(pid)
    proj = load_project(pid)
    fl = next((f for f in proj["floors"] if f["id"] == fid), None)
    if not fl:
        raise HTTPException(404, "층이 없습니다")
    s = merged_settings(proj.get("settings"))
    kinds = tuple(k for k in body.kinds if k in AUTO_KINDS) if body.kinds is not None else auto_kinds(s)
    # automatic items go first so the eraser strokes that follow still wipe them (edits are layered in order)
    manual = [e for e in fl.get("edits", []) if not e.get("auto")]
    fl["edits"] = (detect_edits(load_plan(d / fl["file"]), s, kinds) if kinds else []) + manual
    save_project(pid, proj)
    return public_project(pid)


@app.post("/api/projects/{pid}/floors")
def add_floor(pid: str, plan: UploadFile = File(...), label: str = Form("")):
    d = pdir(pid)
    proj = load_project(pid)
    n = 1 + max((int(f["id"][1:]) for f in proj["floors"]), default=0)
    fl = save_plan_upload(d, plan, f"f{n}", merged_settings(proj.get("settings")))
    fl["label"] = label or f"{len(proj['floors']) + 1}F"
    proj["floors"].append(fl)
    save_project(pid, proj)
    return public_project(pid)


@app.delete("/api/projects/{pid}/floors/{fid}")
def delete_floor(pid: str, fid: str):
    d = pdir(pid)
    proj = load_project(pid)
    fl = next((f for f in proj["floors"] if f["id"] == fid), None)
    if not fl:
        raise HTTPException(404, "층이 없습니다")
    if len(proj["floors"]) == 1:
        raise HTTPException(400, "마지막 도면은 삭제할 수 없습니다")
    proj["floors"].remove(fl)
    gone = {r["id"] for r in proj["rooms"] if r["floor"] == fid}
    proj["rooms"] = [r for r in proj["rooms"] if r["id"] not in gone]
    proj["moves"] = [m for m in proj.get("moves", [])
                     if m["a"]["floor"] != fid and (m.get("b") is None or m["b"]["floor"] != fid)]
    (d / fl["file"]).unlink(missing_ok=True)
    save_project(pid, proj)
    return public_project(pid)


@app.delete("/api/projects/{pid}")
def delete_project(pid: str):
    shutil.rmtree(pdir(pid))
    return {"ok": True}


@app.post("/api/projects/{pid}/analyze")
def analyze(pid: str):
    d = pdir(pid)
    proj = load_project(pid)
    hfov = float(merged_settings(proj.get("settings"))["hfov"])

    def run(update):
        res = analyze_video(str(d / proj["video"]["file"]), hfov, lambda p: update(p, "영상 분석 중"))
        (d / "analysis.json").write_text(json.dumps(res), "utf-8")
        return {"suggestions": len(res["suggestions"])}

    return {"job": start_job(pid, "analyze", run)}


@app.get("/api/projects/{pid}/analysis")
def get_analysis(pid: str):
    a = load_analysis(pid)
    if a is None:
        raise HTTPException(404, "분석 결과가 없습니다")
    return a


@app.get("/api/projects/{pid}/track")
def get_track(pid: str, fps: float = 30.0):
    proj = load_project(pid)
    s = merged_settings(proj.get("settings"))
    fps = min(max(fps, 1.0), 60.0)
    times = np.arange(0, proj["video"]["duration"] + 1 / fps, 1 / fps)
    fids = [f["id"] for f in proj["floors"]]
    windows = show_windows(proj["floors"])
    tr = compute_track(proj.get("moves"), fids, times, s, windows)
    if tr is None:
        # no records: no marker, but floors with a show window still come and go
        tr = plan_only_track(times, windows, s)
        if tr is None:
            return {"fps": fps, "floor": [], "x": [], "y": [], "a": [], "pf": [], "pa": [], "moves": []}
        return {"fps": fps, "floor": [], "x": [], "y": [], "a": [], "moves": [],
                "pf": tr["pfloor"].tolist(), "pa": np.round(tr["panel"], 2).tolist()}
    moves = [{k: v if isinstance(v, (str, bool)) else round(float(v), 2) for k, v in m.items()} for m in tr["moves"]]
    return {"fps": fps, "floor": tr["floor"].tolist(), "moves": moves,
            "x": np.round(tr["x"], 1).tolist(), "y": np.round(tr["y"], 1).tolist(),
            "a": np.round(tr["alpha"], 2).tolist(), "pf": tr["pfloor"].tolist(), "pa": np.round(tr["panel"], 2).tolist()}


@app.get("/api/projects/{pid}/minimap")
def get_minimap(pid: str):
    """Rendered panels + marker sprite at the video's real resolution, for the live preview."""
    d = pdir(pid)
    proj = load_project(pid)
    plans = [load_plan(d / f["file"]) for f in proj["floors"]]
    labels = [f["label"] for f in proj["floors"]]
    v = proj["video"]
    w, h = v["width"] - v["width"] % 2, v["height"] - v["height"] % 2
    rooms = rooms_by_floor(proj["rooms"], [f["id"] for f in proj["floors"]])
    edits = [f.get("edits", []) for f in proj["floors"]]
    return build_preview(plans, labels, proj.get("settings"), title_of(proj), w, h, rooms, edits)


class RenderRequest(BaseModel):
    outputs: list[str] = ["overlay", "minimap"]


@app.post("/api/projects/{pid}/render")
def render(pid: str, body: RenderRequest):
    d = pdir(pid)
    proj = load_project(pid)
    outputs = [o for o in body.outputs if o in ("composite", "overlay", "minimap")]
    if not outputs:
        raise HTTPException(400, "출력 형식을 선택해주세요")
    if any(o in outputs for o in ("composite", "overlay")) and not proj.get("moves"):
        raise HTTPException(400, "이동 지점이 없습니다. ③ 이동 지점에서 출발·도착 지점을 먼저 찍어주세요")

    def run(update):
        files = render_outputs(
            d / proj["video"]["file"], floors_for_render(d, proj), proj["rooms"], proj.get("moves", []),
            proj.get("settings", {}), title_of(proj), d / "outputs", outputs, update,
        )
        return {"files": files}

    return {"job": start_job(pid, "render", run)}


# ---------- style presets (same look across every property / floor) ----------

def load_presets() -> dict:
    return json.loads(PRESETS.read_text("utf-8")) if PRESETS.exists() else {}


@app.get("/api/presets")
def list_presets():
    return load_presets()


class PresetBody(BaseModel):
    name: str
    settings: dict


@app.post("/api/presets")
def save_preset(body: PresetBody):
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "프리셋 이름을 입력해주세요")
    presets = load_presets()
    presets[name] = {k: v for k, v in merged_settings(body.settings).items() if k not in NOT_STYLE}
    PRESETS.write_text(json.dumps(presets, ensure_ascii=False, indent=2), "utf-8")
    return presets


@app.delete("/api/presets/{name}")
def delete_preset(name: str):
    presets = load_presets()
    presets.pop(name, None)
    PRESETS.write_text(json.dumps(presets, ensure_ascii=False, indent=2), "utf-8")
    return presets


@app.get("/api/jobs/{jid}")
def job_status(jid: str):
    job = jobs.get(jid)
    if not job:
        raise HTTPException(404, "작업이 없습니다")
    return job


@app.get("/api/projects/{pid}/files/{name:path}")
def get_file(pid: str, name: str, download: bool = False):
    d = pdir(pid)
    proj = load_project(pid)
    allowed = {"preview.mp4", "project.json", *(f["file"] for f in proj["floors"])}
    if name == "video":
        name = proj["video"]["file"]
    elif name.startswith("outputs/"):
        if "/" in name[8:] or ".." in name or not name.endswith(OUTPUT_EXTS):
            raise HTTPException(404, "파일이 없습니다")
    elif name not in allowed:
        raise HTTPException(404, "파일이 없습니다")
    f = d / name
    if not f.exists():
        raise HTTPException(404, "파일이 아직 생성되지 않았습니다")
    if download:
        return FileResponse(f, filename=f"{proj.get('name', pid)}_{f.name}")
    return FileResponse(f)


class NoCacheStatic(StaticFiles):
    """정적 파일(HTML/CSS/JS)을 브라우저가 매번 서버에 다시 확인하도록 한다.
    수정 후 강력 새로고침 없이도 최신 화면이 뜨게 하기 위함."""

    async def get_response(self, path, scope):
        resp = await super().get_response(path, scope)
        resp.headers["Cache-Control"] = "no-cache"
        return resp


app.mount("/static", NoCacheStatic(directory=ROOT / "static"), name="static")
