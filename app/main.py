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
from .render import (FFMPEG, DEFAULT_SETTINGS, auto_trim, build_preview, decode_plan, imwrite, load_plan,
                     merged_settings, render_outputs, rooms_by_floor, routing, structure_alpha)
from .track import compute_room_track

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


def save_plan_upload(d: Path, upload: UploadFile, fid: str) -> dict:
    img = cv2.imdecode(np.frombuffer(upload.file.read(), np.uint8), cv2.IMREAD_UNCHANGED)
    if img is None:
        raise HTTPException(400, f"도면은 PNG/JPG 이미지로 올려주세요 ({upload.filename})")
    trimmed = auto_trim(decode_plan(img))
    name = f"plan_{fid}.png"
    imwrite(d / name, trimmed)
    return {"id": fid, "file": name, "width": int(trimmed.shape[1]), "height": int(trimmed.shape[0])}


def title_of(proj: dict) -> str:
    s = merged_settings(proj.get("settings"))
    return s["title"] or f"{proj.get('name', '')} mini map".strip()


def floors_for_render(d: Path, proj: dict) -> list[dict]:
    return [{"id": f["id"], "label": f["label"], "path": d / f["file"], "edits": f.get("edits", [])} for f in proj["floors"]]


def public_project(pid: str) -> dict:
    proj = load_project(pid)
    d = pdir(pid)
    proj["id"] = pid
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
            "events": len(p.get("events", [])),
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

        given = [s.strip() for s in labels.split(",")] if labels else []
        floors = []
        for i, up in enumerate(plans):
            fl = save_plan_upload(d, up, f"f{i + 1}")
            fl["label"] = given[i] if i < len(given) and given[i] else f"{i + 1}F"
            floors.append(fl)

        proj = {
            "name": name or Path(video.filename or "영상").stem,
            "created": time.strftime("%Y-%m-%d %H:%M:%S"),
            "video": {"file": vpath.name, "original_name": video.filename, **info},
            "floors": floors,
            "rooms": [],
            "events": [],
            "settings": merged_settings(load_presets().get(preset)),
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
    events: list[dict] | None = None
    settings: dict | None = None


@app.put("/api/projects/{pid}")
def update_project(pid: str, body: ProjectUpdate):
    proj = load_project(pid)
    if body.name is not None:
        proj["name"] = body.name
    if body.floors is not None:
        by_id = {f["id"]: f for f in proj["floors"]}
        proj["floors"] = [{**by_id[f["id"]], "label": str(f.get("label", by_id[f["id"]]["label"])),
                           "edits": clean_edits(f["edits"]) if "edits" in f else by_id[f["id"]].get("edits", [])}
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
    room_ids = {r["id"] for r in proj["rooms"]}
    if body.events is not None:
        try:
            # "mode" overrides the default transition for this one room change
            evs = [{"t": round(float(e["t"]), 3), "room": str(e["room"]),
                    **({"mode": e["mode"]} if e.get("mode") in ("walk", "jump") else {})} for e in body.events]
        except (KeyError, TypeError, ValueError):
            raise HTTPException(400, "잘못된 이동 기록입니다")
        proj["events"] = sorted(evs, key=lambda e: e["t"])
    proj["events"] = [e for e in proj.get("events", []) if e["room"] in room_ids]
    if body.settings is not None:
        proj["settings"] = merged_settings({**proj.get("settings", {}), **body.settings})
    save_project(pid, proj)
    return public_project(pid)


def clean_edits(edits) -> list[dict]:
    """Validate drawing edits: line / door / stairs / rect / circle / toilet / erase, all in plan-pixel coordinates."""
    def pt(v):
        return [round(float(v[0]), 1), round(float(v[1]), 1)]

    out = []
    try:
        for e in edits or []:
            t = e.get("type")
            if t == "line":
                out.append({"type": t, "pts": [pt(v) for v in e["pts"]][:200]})
            elif t in ("rect", "toilet"):
                out.append({"type": t, "a": pt(e["a"]), "b": pt(e["b"])})
            elif t == "circle":
                out.append({"type": t, "c": pt(e["c"]), "r": round(float(e["r"]), 1)})
            elif t == "door":
                out.append({"type": t, "hinge": pt(e["hinge"]), "end": pt(e["end"]), "flip": bool(e.get("flip"))})
            elif t == "stairs":
                item = {"type": t, "a": pt(e["a"]), "b": pt(e["b"])}
                if e.get("steps"):
                    item["steps"] = int(e["steps"])
                out.append(item)
            elif t == "erase":
                out.append({"type": t, "pts": [pt(v) for v in e["pts"]][:2000], "r": round(float(e.get("r", 6)), 1)})
            if t != "erase" and out and e.get("thin"):
                out[-1]["thin"] = True
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


@app.post("/api/projects/{pid}/floors")
def add_floor(pid: str, plan: UploadFile = File(...), label: str = Form("")):
    d = pdir(pid)
    proj = load_project(pid)
    n = 1 + max((int(f["id"][1:]) for f in proj["floors"]), default=0)
    fl = save_plan_upload(d, plan, f"f{n}")
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
    proj["events"] = [e for e in proj["events"] if e["room"] not in gone]
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
    d = pdir(pid)
    fids = [f["id"] for f in proj["floors"]]
    plans = [load_plan(d / f["file"]) for f in proj["floors"]]
    edits = [f.get("edits", []) for f in proj["floors"]]
    tr = compute_room_track(proj["rooms"], proj["events"], fids, times, s, *routing(fids, plans, s, edits))
    if tr is None:
        return {"fps": fps, "floor": [], "x": [], "y": [], "a": [], "moves": []}
    moves = [{k: v if isinstance(v, str) else round(float(v), 2) for k, v in m.items()} for m in tr["moves"]]
    return {"fps": fps, "floor": tr["floor"].tolist(), "moves": moves,
            "x": np.round(tr["x"], 1).tolist(), "y": np.round(tr["y"], 1).tolist(),
            "a": np.round(tr["alpha"], 2).tolist()}


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
    if any(o in outputs for o in ("composite", "overlay")) and not proj["events"]:
        raise HTTPException(400, "방 이동 기록이 없습니다. 영상을 멈추고 출발한 방을 먼저 지정해주세요")

    def run(update):
        files = render_outputs(
            d / proj["video"]["file"], floors_for_render(d, proj), proj["rooms"], proj["events"],
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
