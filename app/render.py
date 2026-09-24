"""Minimap drawing (chalkboard / original style) and video output."""
from __future__ import annotations

import base64
import math
import shutil
import subprocess
from fractions import Fraction
from pathlib import Path
from typing import Callable

import cv2
import imageio_ffmpeg
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from skimage.morphology import skeletonize

from .track import compute_track

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
FONT_DIR = Path(__file__).resolve().parent.parent / "static" / "fonts"
FONTS = {"pen": "NanumPenScript-Regular.ttf", "gothic": "NanumGothic-Bold.ttf"}

DEFAULT_NOTE = "※ 이해를 돕기위한 미니맵 입니다. 실제와 다를 수 있습니다."

DEFAULT_SETTINGS = {
    # placement
    "corner": "br",            # br | bl | tr | tl
    "size": 0.3,               # panel max width, fraction of video width
    "max_height": 0.5,         # panel max height, fraction of video height
    "margin": 0.025,           # fraction of min(video w, h)
    "opacity": 1.0,
    # look
    "style": "chalk",          # chalk: plan lines redrawn as chalk on a dark board | original: plan image as-is
    "panel_color": "#6e655c",
    "panel_opacity": 0.92,
    "line_color": "#f4f1ea",
    "line_threshold": 170,     # chalk: plan pixels darker than this become lines
    "line_mode": "structure",  # structure | walls | lines | none (see plan_structure)
    "uniform_lines": True,     # redraw extracted lines at one fixed thickness (consistent look across plans)
    "line_width": 1.0,
    "chalk_texture": True,
    "auto_crop": True,         # fit the minimap to the drawn structure (drops captions like "A-2 (1st Floor)")
    "panel_ratio": 0.8,        # plan area height / width, fixed so every overlay has the same frame; 0 = follow the plan
    "same_scale": True,        # multi-floor projects: draw every floor at the same scale
    "font": "pen",             # pen | gothic
    "title": "",               # empty -> "<project name> mini map"
    "show_title": False,       # "<name> mini map" text next to the floor label
    "show_floor_label": True,  # "1F" at the top
    "note": DEFAULT_NOTE,
    "show_note": False,        # disclaimer line at the bottom
    "show_room_names": True,
    "room_name_size": 1.0,
    # marker
    "marker_color": "#ffffff",
    "marker_size": 1.0,
    "glow": True,
    "fade_sec": 0.6,           # fade-out + fade-in time (floor changes, "스르르" moves, fading over to a move's start point)
    "panel_fade_sec": 0.6,     # the plan itself eases in/out at each floor's show window
    # output
    "overlay_codec": "qtrle",  # qtrle: QuickTime Animation (lossless, ~100MB / 10 min 2K) | prores: ProRes 4444 (~4.5GB)
    # automatic vector detection when a plan is uploaded (and on "다시 인식"), see vectorize.py
    "auto_walls": True,        # walls as straight lines with clean corners
    "auto_thin": True,         # thin partitions between walls, windows in the outer walls
    "auto_doors": True,        # door swing arcs
    "auto_stairs": True,       # runs of evenly spaced step lines
    # motion analysis (room-change suggestions)
    "hfov": 80,
}


def auto_kinds(settings: dict) -> tuple[str, ...]:
    return tuple(k for k in ("walls", "thin", "doors", "stairs") if settings.get(f"auto_{k}", True))


def merged_settings(s: dict | None) -> dict:
    out = dict(DEFAULT_SETTINGS)
    out.update({k: v for k, v in (s or {}).items() if k in DEFAULT_SETTINGS})
    return out


def hex_bgr(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    r, g, b = (int(h[i : i + 2], 16) for i in (0, 2, 4))
    return b, g, r


def imwrite(path: str | Path, img: np.ndarray, params: list[int] | None = None) -> None:
    """cv2.imwrite that also works for non-ASCII (e.g. Korean) paths on Windows."""
    ok, buf = cv2.imencode(Path(path).suffix or ".png", img, params or [])
    if not ok:
        raise RuntimeError(f"이미지를 저장할 수 없습니다: {path}")
    buf.tofile(str(path))


def decode_plan(img: np.ndarray | None) -> np.ndarray:
    """Plan as BGR, flattening any transparency onto white."""
    if img is None:
        raise RuntimeError("도면 이미지를 열 수 없습니다")
    if img.ndim == 2:
        return cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    if img.shape[2] == 4:
        a = img[:, :, 3:4].astype(np.float32) / 255
        return (img[:, :, :3] * a + 255 * (1 - a)).astype(np.uint8)
    return img


def load_plan(path: str | Path) -> np.ndarray:
    return decode_plan(cv2.imdecode(np.fromfile(str(path), np.uint8), cv2.IMREAD_UNCHANGED))


def auto_trim(img: np.ndarray, pad_ratio: float = 0.03) -> np.ndarray:
    """Crop away near-white borders around the drawing."""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    ys, xs = np.where(gray < 235)
    if len(xs) < 50:
        return img
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    pad = int(max(img.shape[:2]) * pad_ratio)
    h, w = gray.shape
    return img[max(0, y0 - pad) : min(h, y1 + pad + 1), max(0, x0 - pad) : min(w, x1 + pad + 1)]


def _chalk_noise(h: int, w: int, seed: int = 7) -> np.ndarray:
    rng = np.random.default_rng(seed)
    n = rng.uniform(0.45, 1.0, (h, w)).astype(np.float32)
    return cv2.GaussianBlur(n, (3, 3), 0)


WORK_PX = 1200  # plans are analysed at this size (long side), whatever their upload resolution
_struct_cache: dict[tuple, dict] = {}


def work_image(plan: np.ndarray) -> tuple[float, np.ndarray]:
    """(scale, plan resized to the working resolution)."""
    ph, pw = plan.shape[:2]
    k = WORK_PX / max(ph, pw)
    big = cv2.resize(plan, (max(1, round(pw * k)), max(1, round(ph * k))),
                     interpolation=cv2.INTER_CUBIC if k > 1 else cv2.INTER_AREA)
    return k, big


def plan_structure(plan: np.ndarray, settings: dict, edits: list[dict] | None = None) -> dict:
    """Automatic line mask of the plan at working resolution, minus the user's eraser strokes.

    line_mode:
      structure - walls of rendered/colour plans: dark, neutral, thick, connected strokes (drops furniture, textures, captions)
      walls     - thick strokes of black-and-white plans (drops door arcs, furniture, dimensions, text)
      lines     - every line except text
      none      - nothing automatic; the plan is drawn only with the edit tools
    Returns {"k": plan->work scale, "mask": uint8 mask, "center": uint8 centre lines, "bbox": plan-coords box}.
    """
    edits = edits or []
    erase = [e for e in edits if e.get("type") == "erase"]
    key = (plan.shape, int(plan[::7, ::7].sum()), settings["line_threshold"], settings["line_mode"], repr(erase))
    if key in _struct_cache:
        return _struct_cache[key]

    k, big = work_image(plan)
    gray = cv2.cvtColor(big, cv2.COLOR_BGR2GRAY)
    thr = float(settings["line_threshold"])
    mode = settings["line_mode"]

    if mode == "none":
        mask = np.zeros(gray.shape, np.uint8)
    elif mode == "structure":
        # walls in rendered plans are near-black and colourless; furniture/wood/marble are not
        sat = cv2.cvtColor(big, cv2.COLOR_BGR2HSV)[:, :, 1]
        mask = ((gray < thr * 0.45) & (sat < 80)).astype(np.uint8)
        t = max(3, int(0.012 * WORK_PX))
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (t, t)))
        mask = _drop_small_components(mask, 0.15 * WORK_PX)
    else:
        mask = (gray < thr).astype(np.uint8)
        lines_only = _drop_small_components(mask, 0.05 * WORK_PX)  # text, numbers, symbols
        mask = lines_only
        if mode == "walls":
            t = max(3, int(round(0.006 * WORK_PX)))
            walls = cv2.morphologyEx(lines_only, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (t, t)))
            walls = _drop_small_components(walls, 0.03 * WORK_PX)
            # plans that draw walls as thin double lines would lose everything: keep all lines then
            if walls.sum() > 0.2 * lines_only.sum():
                mask = walls

    for e in erase:
        pts = (np.asarray(e["pts"], np.float32) * k).astype(np.int32)
        r = max(1, int(float(e.get("r", 6)) * k))
        if len(pts) == 1:
            cv2.circle(mask, tuple(int(v) for v in pts[0]), r, 0, -1)
        else:
            cv2.polylines(mask, [pts], False, 0, 2 * r)

    center = _prune(skeletonize(mask > 0).astype(np.uint8), int(0.02 * WORK_PX)) if mask.any() else mask
    ys, xs = np.where(mask > 0)
    bbox = (xs.min() / k, ys.min() / k, (xs.max() + 1) / k, (ys.max() + 1) / k) if len(xs) else None
    res = {"k": k, "mask": mask, "center": center, "bbox": bbox}
    if len(_struct_cache) > 16:
        _struct_cache.clear()
    _struct_cache[key] = res
    return res


def _prune(skel: np.ndarray, length: int) -> np.ndarray:
    """Remove skeleton spurs shorter than `length` px, keeping the main lines' full extent."""
    kernel = np.array([[1, 1, 1], [1, 10, 1], [1, 1, 1]], np.float32)

    def endpoints(img):
        return (cv2.filter2D(img, -1, kernel, borderType=cv2.BORDER_CONSTANT) == 11).astype(np.uint8)

    thin = skel.copy()
    for _ in range(length):
        e = endpoints(thin)
        if not e.any():
            break
        thin[e > 0] = 0
    # regrow only from the ends that survived, along the original skeleton
    grow = endpoints(thin)
    for _ in range(length):
        grow = cv2.dilate(grow, np.ones((3, 3), np.uint8)) & skel
    return thin | grow


def edits_bbox(edits: list[dict]) -> tuple | None:
    pts = [p for e in edits if e.get("type") != "erase" for p in _edit_points(e)]
    if not pts:
        return None
    a = np.asarray(pts, float)
    return a[:, 0].min(), a[:, 1].min(), a[:, 0].max(), a[:, 1].max()


def _edit_points(e: dict) -> list:
    t = e.get("type")
    if t == "line":
        return e["pts"]
    if t == "door":
        (hx, hy), (ex, ey) = e["hinge"], e["end"]
        r = math.hypot(ex - hx, ey - hy)
        return [[hx - r, hy - r], [hx + r, hy + r]]
    if t in ("stairs", "rect", *FIXTURE_TYPES):
        return [e["a"], e["b"]]
    if t == "circle":
        (cx, cy), r = e["c"], float(e["r"])
        return [[cx - r, cy - r], [cx + r, cy + r]]
    if t == "toilet":
        (ax, ay), (bx, by) = e["a"], e["b"]
        r = math.hypot(bx - ax, by - ay)
        return [[ax - r, ay - r], [ax + r, ay + r]]
    return []


TOILET_ELONGATION = 2.6   # toilet depth / half width ("D" shape: straight sides, round front; 1.0 = plain semicircle)
FIXTURE_TYPES = ("basin", "sink", "induction", "closet")   # box fixtures drawn from corner a to corner b


def _box(e: dict) -> tuple[float, float, float, float]:
    (x0, y0), (x1, y1) = e["a"], e["b"]
    return min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)


def draw_edits(img: np.ndarray, edits: list[dict], scale: float, offset=(0.0, 0.0), value=1, thickness: int = 1) -> None:
    """Vector edits (line / door / stairs / rect / circle / toilet) in plan coordinates, drawn onto img at `scale`.
    Items with "thin": true are drawn at a bit under half the line thickness."""
    S = 16
    ox, oy = offset
    normal = thickness

    def P(pt):
        return int(round((pt[0] * scale - ox) * S)), int(round((pt[1] * scale - oy) * S))

    def line(p, q):
        cv2.line(img, P(p), P(q), value, thickness, cv2.LINE_AA, shift=4)

    for e in edits:
        t = e.get("type")
        thickness = max(1, int(round(normal * 0.45))) if e.get("thin") else normal
        if t == "rect":
            cv2.rectangle(img, P(e["a"]), P(e["b"]), value, thickness, cv2.LINE_AA, shift=4)
            continue
        if t in FIXTURE_TYPES:
            # simple plan symbols: counter box + bowl / burners / hanging rod
            x0, y0, x1, y1 = _box(e)
            w, h = x1 - x0, y1 - y0
            cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
            cv2.rectangle(img, P((x0, y0)), P((x1, y1)), value, thickness, cv2.LINE_AA, shift=4)
            if t == "basin":         # oval bowl in the counter
                cv2.ellipse(img, P((cx, cy)), (int(w * 0.34 * scale * S), int(h * 0.34 * scale * S)), 0, 0, 360, value, thickness, cv2.LINE_AA, shift=4)
            elif t == "sink":        # rectangular bowl, inset
                ix, iy = w * 0.18, h * 0.18
                cv2.rectangle(img, P((x0 + ix, y0 + iy)), P((x1 - ix, y1 - iy)), value, thickness, cv2.LINE_AA, shift=4)
            elif t == "induction":   # burners: 2x2 on a square-ish top, a row of 3 along a long one
                if 0.6 <= w / max(h, 1e-6) <= 1.6:
                    centres = [(x0 + w * fx, y0 + h * fy) for fx in (0.3, 0.7) for fy in (0.3, 0.7)]
                    r = min(w, h) * 0.14
                else:
                    along = w >= h
                    centres = [((x0 + w * (i + 0.5) / 3, cy) if along else (cx, y0 + h * (i + 0.5) / 3)) for i in range(3)]
                    r = min(w, h) * 0.28
                for c in centres:
                    cv2.circle(img, P(c), int(r * scale * S), value, thickness, cv2.LINE_AA, shift=4)
            elif t == "closet":      # hanging rod along the long side with hanger ticks
                along = w >= h
                short = min(w, h)
                step = max(short * 0.5, 1e-6)
                n = int(min(30, max(w, h) // step))
                tick = short * 0.22
                if along:
                    line((x0, cy), (x1, cy))
                    for i in range(1, n):
                        line((x0 + i * step, cy - tick), (x0 + i * step, cy + tick))
                else:
                    line((cx, y0), (cx, y1))
                    for i in range(1, n):
                        line((cx - tick, y0 + i * step), (cx + tick, y0 + i * step))
            continue
        if t == "circle":
            r = float(e["r"]) * scale
            cv2.circle(img, P(e["c"]), int(r * S), value, thickness, cv2.LINE_AA, shift=4)
            continue
        if t == "toilet":
            # "D" shape: flat side on the wall at a, straight sides, semicircular front reaching b
            (ax, ay), (bx, by) = e["a"], e["b"]
            depth = math.hypot(bx - ax, by - ay)
            w = depth / TOILET_ELONGATION                       # half width = front radius
            ux, uy = (bx - ax) / (depth or 1), (by - ay) / (depth or 1)
            nx, ny = -uy, ux
            cx, cy = ax + ux * (depth - w), ay + uy * (depth - w)   # centre of the front semicircle
            ang = math.degrees(math.atan2(uy, ux))
            for sgn in (1, -1):
                cv2.line(img, P((ax + sgn * nx * w, ay + sgn * ny * w)), P((cx + sgn * nx * w, cy + sgn * ny * w)), value, thickness, cv2.LINE_AA, shift=4)
            cv2.ellipse(img, P((cx, cy)), (int(w * scale * S), int(w * scale * S)), ang, -90, 90, value, thickness, cv2.LINE_AA, shift=4)
            cv2.line(img, P((ax - nx * w, ay - ny * w)), P((ax + nx * w, ay + ny * w)), value, thickness, cv2.LINE_AA, shift=4)
            continue
        if t == "line" and len(e.get("pts", [])) >= 2:
            cv2.polylines(img, [np.array([P(p) for p in e["pts"]], np.int32)], False, value, thickness, cv2.LINE_AA, shift=4)
        elif t == "door":
            (hx, hy), (ex, ey) = e["hinge"], e["end"]
            cv2.line(img, P((hx, hy)), P((ex, ey)), value, thickness, cv2.LINE_AA, shift=4)
            r = math.hypot(ex - hx, ey - hy) * scale
            a0 = math.degrees(math.atan2(ey - hy, ex - hx))
            a1 = a0 + (-90 if e.get("flip") else 90)
            cv2.ellipse(img, P((hx, hy)), (int(r * S), int(r * S)), 0, min(a0, a1), max(a0, a1), value, thickness, cv2.LINE_AA, shift=4)
        elif t == "stairs":
            (x0, y0), (x1, y1) = e["a"], e["b"]
            x0, x1, y0, y1 = min(x0, x1), max(x0, x1), min(y0, y1), max(y0, y1)
            cv2.rectangle(img, P((x0, y0)), P((x1, y1)), value, thickness, cv2.LINE_AA, shift=4)
            w, h = x1 - x0, y1 - y0
            n = int(e.get("steps") or np.clip(round(max(w, h) / (min(w, h) * 0.45 + 1e-6)), 4, 18))
            across = (h >= w) != bool(e.get("flip"))   # flip swaps the direction of the step lines
            for i in range(1, n):
                if across:
                    y = y0 + h * i / n
                    cv2.line(img, P((x0, y)), P((x1, y)), value, thickness, cv2.LINE_AA, shift=4)
                else:
                    x = x0 + w * i / n
                    cv2.line(img, P((x, y0)), P((x, y1)), value, thickness, cv2.LINE_AA, shift=4)


def erase_strokes(img: np.ndarray, edits: list[dict], scale: float, offset=(0.0, 0.0)) -> None:
    """Paint the eraser strokes (plan coordinates) as 0 onto img at `scale`."""
    ox, oy = offset
    for e in edits:
        if e.get("type") != "erase":
            continue
        pts = (np.asarray(e["pts"], np.float32) * scale - (ox, oy)).astype(np.int32)
        r = max(1, int(float(e.get("r", 6)) * scale))
        if len(pts) == 1:
            cv2.circle(img, tuple(int(v) for v in pts[0]), r, 0, -1)
        else:
            cv2.polylines(img, [pts], False, 0, 2 * r)


def structure_alpha(plan: np.ndarray, settings: dict, edits: list[dict], crop: tuple, iw: int, ih: int,
                    line_px: float, with_vectors: bool = True) -> np.ndarray:
    """Final line alpha (ih, iw) for the plan area `crop` (plan coords): automatic lines + drawn edits."""
    st = plan_structure(plan, settings, edits)
    cx0, cy0, cx1, cy1 = crop
    k = st["k"]
    x0, y0 = int(max(0, cx0 * k)), int(max(0, cy0 * k))
    x1, y1 = int(min(st["mask"].shape[1], cx1 * k)), int(min(st["mask"].shape[0], cy1 * k))
    W2, H2 = iw * 2, ih * 2
    sc2 = W2 / (cx1 - cx0)  # plan px -> 2x panel px
    auto = [e for e in edits if e.get("auto") and e.get("type") != "erase"]

    canvas = np.zeros((H2, W2), np.float32)
    if auto:
        # the automatic lines were vectorised from this raster: draw the clean vectors instead
        src = np.zeros((0, 0), np.float32)
    elif settings["uniform_lines"]:
        src = st["center"][y0:y1, x0:x1].astype(np.float32)
    else:
        src = st["mask"][y0:y1, x0:x1].astype(np.float32)
    if src.size:
        # place the working-resolution crop onto the 2x canvas
        tw, th = max(1, round((x1 - x0) / k * sc2)), max(1, round((y1 - y0) / k * sc2))
        dx, dy = round((x0 / k - cx0) * sc2), round((y0 / k - cy0) * sc2)
        part = cv2.resize(src, (tw, th), interpolation=cv2.INTER_AREA)
        part = (part > 0.02).astype(np.float32) if settings["uniform_lines"] else part
        ys, xs = slice(max(0, dy), min(H2, dy + th)), slice(max(0, dx), min(W2, dx + tw))
        canvas[ys, xs] = part[ys.start - dy : ys.stop - dy, xs.start - dx : xs.stop - dx]

    d = max(2, int(round(line_px * 2)))
    if settings["uniform_lines"] and src.size:
        canvas = cv2.dilate(canvas, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (d, d)))
    if with_vectors:
        # edits are layered in order: an eraser stroke wipes everything drawn before it (the raster and
        # any earlier vector items); items drawn after it stay whole
        vec = np.zeros((H2, W2), np.uint8)
        offset = (cx0 * sc2, cy0 * sc2)
        for e in edits:
            if e.get("type") == "erase":
                erase_strokes(vec, [e], sc2, offset)
            else:
                draw_edits(vec, [e], sc2, offset, 255, d)
        canvas = np.maximum(canvas, vec.astype(np.float32) / 255)
    canvas = cv2.GaussianBlur(canvas, (3, 3), 0)
    return np.clip(cv2.resize(canvas, (iw, ih), interpolation=cv2.INTER_AREA) * 1.3, 0, 1)


def auto_crop(plan: np.ndarray, settings: dict, edits: list[dict]) -> tuple:
    """Plan-coordinate box around the drawn structure (drops captions/banners/empty margins)."""
    ph, pw = plan.shape[:2]
    boxes = [b for b in (plan_structure(plan, settings, edits)["bbox"], edits_bbox(edits)) if b]
    if not boxes:
        return (0, 0, pw, ph)
    x0 = min(b[0] for b in boxes); y0 = min(b[1] for b in boxes)
    x1 = max(b[2] for b in boxes); y1 = max(b[3] for b in boxes)
    m = 0.04 * max(x1 - x0, y1 - y0)
    return (max(0, x0 - m), max(0, y0 - m), min(pw, x1 + m), min(ph, y1 + m))


def _drop_small_components(mask: np.ndarray, min_extent: float) -> np.ndarray:
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    extent = np.maximum(stats[:, cv2.CC_STAT_WIDTH], stats[:, cv2.CC_STAT_HEIGHT])
    keep = extent >= min_extent
    keep[0] = False
    return keep[labels].astype(np.uint8)


def _font(settings: dict, px: float, name: str | None = None) -> ImageFont.FreeTypeFont:
    file = FONTS.get(name or settings["font"], FONTS["pen"])
    return ImageFont.truetype(str(FONT_DIR / file), max(8, int(round(px))))


def _has_glyph(font: ImageFont.FreeTypeFont, ch: str) -> bool:
    if ch.isspace():
        return True
    return bytes(font.getmask(ch)) != bytes(font.getmask("\uffff"))


def _draw_text(d: ImageDraw.ImageDraw, x: float, y: float, text: str, font, fallback, align: str, fill: int) -> None:
    """Baseline-anchored text; characters missing from `font` (e.g. ※ in the pen font) use `fallback`."""
    runs: list[tuple[str, ImageFont.FreeTypeFont]] = []
    for ch in text:
        f = font if _has_glyph(font, ch) else fallback
        if runs and runs[-1][1] is f:
            runs[-1] = (runs[-1][0] + ch, f)
        else:
            runs.append((ch, f))
    total = sum(d.textlength(t, font=f) for t, f in runs)
    x -= {"l": 0, "m": total / 2, "r": total}[align]
    for t, f in runs:
        d.text((x, y), t, font=f, fill=fill, anchor="ls")
        x += d.textlength(t, font=f)


# marker glow "breathing": brightness follows video time so preview and render agree
PULSE_PERIOD = 1.2        # seconds per bright-dim-bright cycle
PULSE_MIN = 0.08          # dimmest glow as a fraction of the brightest
PULSE_STEPS = 12          # distinct brightness levels (keeps the overlay frame cache small)
PULSE_GLOW_MAX = 0.55     # peak glow alpha right at the dot edge (kept below the dot so it stays in front)


def pulse_level(t: float) -> float:
    """0..1 glow level at video time t, quantised to PULSE_STEPS."""
    lv = 0.5 - 0.5 * math.cos(2 * math.pi * t / PULSE_PERIOD)
    return round(lv * (PULSE_STEPS - 1)) / (PULSE_STEPS - 1)


def pulse_factor(level: float) -> float:
    return PULSE_MIN + (1 - PULSE_MIN) * float(level)


def _over(c_bottom: np.ndarray, a_bottom: np.ndarray, c_top: np.ndarray, a_top: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Porter-Duff "over" with straight (non-premultiplied) colours; alphas are HxW floats 0..1."""
    a = a_top + a_bottom * (1 - a_top)
    num = c_top * a_top[..., None] + c_bottom * (a_bottom * (1 - a_top))[..., None]
    return num / np.maximum(a, 1e-6)[..., None], a


class Minimap:
    """Static panel per floor + glowing marker sprite. Size is decided by max_w/max_h."""

    def __init__(self, plans: list[np.ndarray], labels: list[str], settings: dict, title: str, max_w: float, max_h: float,
                 rooms: list[list[dict]] | None = None, edits: list[list[dict]] | None = None):
        s = self.s = settings
        self.labels = labels
        rooms = rooms or [[] for _ in plans]
        edits = edits or [[] for _ in plans]
        chalk = s["style"] == "chalk"
        # plan area actually shown per floor, in plan coordinates
        crops = [auto_crop(p, s, e) if (chalk and s["auto_crop"]) else (0, 0, p.shape[1], p.shape[0])
                 for p, e in zip(plans, edits)]
        sizes = [(c[2] - c[0], c[3] - c[1]) for c in crops]
        # header row: the floor label and/or the title, each switchable on its own
        title = title if s["show_title"] else ""
        show_title = bool(title or (s["show_floor_label"] and any(labels)))
        show_note = bool(s["show_note"] and s["note"])
        ratio = float(s["panel_ratio"]) or max(h / w for w, h in sizes)

        def layout(wp: float) -> dict:
            pad = 0.05 * wp
            title_h = 0.11 * wp if show_title else 0
            note_h = 0.07 * wp if show_note else 0
            plan_w = wp - 2 * pad
            plan_h = plan_w * ratio
            return {"wp": wp, "pad": pad, "title_h": title_h, "note_h": note_h, "plan_w": plan_w, "plan_h": plan_h,
                    "hp": 2 * pad + title_h + plan_h + note_h}

        L = layout(max_w)
        if L["hp"] > max_h:
            L = layout(max_w * max_h / L["hp"])
        self.w, self.h = int(round(L["wp"])), int(round(L["hp"]))
        W, H = self.w, self.h
        pad, box_y = L["pad"], L["pad"] + L["title_h"]

        # board background: panel colour with a soft diagonal vignette on the chalkboard look
        col = np.array(hex_bgr(s["panel_color"]), np.float32)
        if chalk and s["chalk_texture"]:
            yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
            g = (xx / max(W, 1) + yy / max(H, 1)) / 2
            bg = col[None, None] * (1.08 - 0.3 * g)[:, :, None]
        else:
            bg = np.broadcast_to(col, (H, W, 3)).copy()
        bg = np.clip(bg, 0, 255)

        mask = self._round_mask(W, H, max(3, int(min(W, H) * 0.035)))
        noise = _chalk_noise(H, W) if (s["style"] == "chalk" and s["chalk_texture"]) else np.ones((H, W), np.float32)
        line = np.array(hex_bgr(s["line_color"]), np.float32)

        self.bases: list[np.ndarray] = []
        self.alphas: list[np.ndarray] = []
        self.fits: list[tuple[float, float, float]] = []  # (ox, oy, scale) plan px -> panel px
        self._make_marker(L["wp"])
        fit = [min(L["plan_w"] / w, L["plan_h"] / h) for w, h in sizes]
        if s["same_scale"]:
            fit = [min(fit)] * len(plans)
        line_px = 0.0065 * L["wp"] * float(s["line_width"])
        for plan, label, sc, floor_rooms, crop, floor_edits in zip(plans, labels, fit, rooms, crops, edits):
            cw, ch = crop[2] - crop[0], crop[3] - crop[1]
            iw, ih = max(1, int(round(cw * sc))), max(1, int(round(ch * sc)))
            ox = int(round((W - iw) / 2))
            oy = int(round(box_y + (L["plan_h"] - ih) * 0.2))   # spare height goes mostly below: keeps the plan close to its label
            # (ox, oy) is where the crop's corner lands; fits map *plan* coordinates
            fit_xy = (ox - crop[0] * sc, oy - crop[1] * sc, sc)
            self.fits.append(fit_xy)

            # layers: background board -> lines & text. Lines/text keep their own opacity, so a
            # see-through background (panel_opacity 0) still shows the plan (with no halo around the lines).
            img = bg.copy()
            alpha = mask * float(s["panel_opacity"])
            content = np.zeros((H, W), np.float32)
            if chalk:
                content[oy : oy + ih, ox : ox + iw] = structure_alpha(plan, s, floor_edits, crop, iw, ih, line_px)
            else:
                x0, y0 = int(crop[0]), int(crop[1])
                src = plan[y0 : y0 + int(ch), x0 : x0 + int(cw)]
                img[oy : oy + ih, ox : ox + iw] = cv2.resize(src, (iw, ih), interpolation=cv2.INTER_AREA)
                alpha = alpha.copy()
                alpha[oy : oy + ih, ox : ox + iw] = mask[oy : oy + ih, ox : ox + iw]

            # header text lines up with the right edge of this floor's plan (not the board's padding)
            text_a = self._text_layer(W, H, L, title, label if s["show_floor_label"] else "", show_title, show_note, ox + iw)
            if s["show_room_names"]:
                self._room_names(text_a, floor_rooms, fit_xy, L, (oy, oy + ih))
            content = np.maximum(content, text_a) * noise
            img, alpha = _over(img, alpha, line, content)
            self.bases.append(np.clip(img, 0, 255).astype(np.uint8))
            self.alphas.append((alpha * mask * float(s["opacity"])).astype(np.float32))

        self.x0 = self.y0 = 0

    @staticmethod
    def _round_mask(w: int, h: int, r: int) -> np.ndarray:
        m = np.zeros((h, w), np.uint8)
        cv2.rectangle(m, (r, 0), (w - r - 1, h - 1), 255, -1)
        cv2.rectangle(m, (0, r), (w - 1, h - r - 1), 255, -1)
        for cx, cy in ((r, r), (w - r - 1, r), (r, h - r - 1), (w - r - 1, h - r - 1)):
            cv2.circle(m, (cx, cy), r, 255, -1, cv2.LINE_AA)
        return m.astype(np.float32) / 255

    def _text_layer(self, W: int, H: int, L: dict, title: str, label: str, show_title: bool, show_note: bool,
                    right: float | None = None) -> np.ndarray:
        layer = Image.new("L", (W, H), 0)
        d = ImageDraw.Draw(layer)
        pad = L["pad"]
        if show_title:
            f_title = _font(self.s, 0.075 * L["wp"])
            f_label = _font(self.s, 0.105 * L["wp"])
            fb_title = _font(self.s, 0.06 * L["wp"], "gothic")
            base_y = pad + L["title_h"] * 0.86  # text baseline, close above the plan
            x = W - pad if right is None else min(W - pad, float(right))
            if label:
                x -= d.textlength(label, font=f_label)
                _draw_text(d, x, base_y, label, f_label, fb_title, "l", 255)
                x -= 0.025 * L["wp"]
            if title:
                _draw_text(d, x, base_y, title, f_title, fb_title, "r", 255)
        if show_note:
            f_note = _font(self.s, 0.04 * L["wp"])
            fb_note = _font(self.s, 0.03 * L["wp"], "gothic")
            _draw_text(d, W / 2, H - pad - L["note_h"] * 0.3, self.s["note"], f_note, fb_note, "m", 235)
        return np.asarray(layer, np.float32) / 255

    def _room_names(self, layer: np.ndarray, rooms: list[dict], fit: tuple, L: dict, plan_y: tuple[int, int]) -> None:
        """Room names centred exactly on the spot the user clicked (a room is only a label; pick a clean spot)."""
        if not rooms:
            return
        H, W = layer.shape
        img = Image.new("L", (W, H), 0)
        d = ImageDraw.Draw(img)
        px = 0.045 * L["wp"] * float(self.s["room_name_size"])
        font = _font(self.s, px)
        fallback = _font(self.s, px * 0.8, "gothic")
        ox, oy, sc = fit
        for r in rooms:
            if not r.get("name"):
                continue
            x, y = ox + float(r["x"]) * sc, oy + float(r["y"]) * sc
            _, top, _, bottom = font.getbbox(r["name"], anchor="ls")   # glyph extent relative to the baseline
            _draw_text(d, x, y - (top + bottom) / 2, r["name"], font, fallback, "m", 255)
        layer[:] = np.maximum(layer, np.asarray(img, np.float32) / 255)

    def _make_marker(self, wp: float) -> None:
        """Three sprite layers, bottom to top: dark rim (shadow), glow, body.
        The glow is kept apart so it can breathe like a LIVE badge (see pulse_factor)."""
        s = self.s
        r = 0.036 * wp * float(s["marker_size"])
        glow = s["glow"]
        half = int(math.ceil(r * (1.6 if glow else 0.8)))
        ss = 4
        n = (2 * half + 1) * ss
        yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
        d = np.hypot(xx - n / 2, yy - n / 2) / ss
        color = np.array(hex_bgr(s["marker_color"]), np.float32)

        # body: one small filled dot; the glow is a soft ring hugging its edge (only the rim sparkles)
        rd = 0.6 * r
        # full strength up to the dot's edge, then fades outward -> the dot always sits crisply on top
        a_glow = (np.exp(-((np.maximum(d - 1.02 * rd, 0) / (0.45 * rd)) ** 2)) if glow else np.zeros_like(d)).astype(np.float32)
        a_disc = np.clip(rd - d + 0.5, 0, 1).astype(np.float32)
        body = np.broadcast_to(color, (n, n, 3)).copy()
        # dark rim under the glow, only as strong as the board is see-through
        shadow_k = 0.55 * (1 - float(s["panel_opacity"]))
        a_shadow = (0.6 * shadow_k * np.clip((1.3 * rd - d) / (0.3 * rd), 0, 1)).astype(np.float32)

        size = (2 * half + 1, 2 * half + 1)

        def down(rgb: np.ndarray, a: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
            pm = cv2.resize(rgb * a[..., None], size, interpolation=cv2.INTER_AREA)
            a2 = cv2.resize(a, size, interpolation=cv2.INTER_AREA)
            rgb2 = np.where(a2[..., None] > 1e-4, pm / np.maximum(a2[..., None], 1e-4), 0)
            return rgb2.astype(np.float32), a2.astype(np.float32)

        self.m_shadow = down(np.zeros((n, n, 3), np.float32), a_shadow)
        self.m_glow = down(np.broadcast_to(color, (n, n, 3)).copy(), a_glow)
        self.m_body = down(body, a_disc)
        self.m_half = half
        self.marker_r = r

    def marker_sprite(self, pulse: float = 1.0) -> tuple[np.ndarray, np.ndarray]:
        """The whole marker (straight rgb, alpha) with the glow at the given brightness 0..1."""
        rgb, a = self.m_shadow
        rgb, a = _over(rgb, a, self.m_glow[0], self.m_glow[1] * (PULSE_GLOW_MAX * pulse_factor(pulse)))
        rgb, a = _over(rgb, a, self.m_body[0], self.m_body[1])
        return rgb, a

    def place(self, frame_w: int, frame_h: int) -> None:
        m = int(round(self.s["margin"] * min(frame_w, frame_h)))
        c = self.s["corner"]
        x0 = m if "l" in c else frame_w - self.w - m
        y0 = m if "t" in c else frame_h - self.h - m
        self.x0 = int(np.clip(x0, 0, max(0, frame_w - self.w)))
        self.y0 = int(np.clip(y0, 0, max(0, frame_h - self.h)))

    def to_panel(self, floor: int, x: float, y: float) -> tuple[float, float]:
        ox, oy, sc = self.fits[floor]
        return ox + x * sc, oy + y * sc

    def draw(self, floor: int, x: float, y: float, marker_alpha: float = 1.0, pulse: float = 1.0,
             panel_alpha: float = 1.0) -> tuple[np.ndarray, np.ndarray]:
        img = self.bases[floor].copy()
        alpha = self.alphas[floor].copy()
        if panel_alpha <= 0:
            return img, np.zeros_like(alpha)
        px, py = self.to_panel(floor, x, y)
        m_rgb, m_a = self.marker_sprite(pulse)
        hf = self.m_half
        cx, cy = int(round(px)), int(round(py))
        x0, y0, x1, y1 = cx - hf, cy - hf, cx + hf + 1, cy + hf + 1
        sx0, sy0 = max(0, -x0), max(0, -y0)
        x0c, y0c, x1c, y1c = max(0, x0), max(0, y0), min(self.w, x1), min(self.h, y1)
        if x1c > x0c and y1c > y0c:
            sa = m_a[sy0 : sy0 + (y1c - y0c), sx0 : sx0 + (x1c - x0c)] * float(marker_alpha)
            sr = m_rgb[sy0 : sy0 + (y1c - y0c), sx0 : sx0 + (x1c - x0c)]
            roi = img[y0c:y1c, x0c:x1c]
            ar = alpha[y0c:y1c, x0c:x1c]
            c, a = _over(roi.astype(np.float32), ar, sr, sa * float(self.s["opacity"]))
            roi[:] = np.clip(c, 0, 255).astype(np.uint8)
            ar[:] = a
        if panel_alpha < 1:
            alpha *= float(panel_alpha)   # the whole panel (board, lines, names, marker) eases in / out together
        return img, alpha

    def composite(self, frame: np.ndarray, panel: np.ndarray, alpha: np.ndarray) -> None:
        roi = frame[self.y0 : self.y0 + self.h, self.x0 : self.x0 + self.w]
        a = alpha[: roi.shape[0], : roi.shape[1], None]
        p = panel[: roi.shape[0], : roi.shape[1]]
        roi[:] = (p * a + roi * (1 - a)).astype(np.uint8)

    def rgba(self, floor: int, panel: np.ndarray | None = None, alpha: np.ndarray | None = None) -> np.ndarray:
        panel = self.bases[floor] if panel is None else panel
        alpha = self.alphas[floor] if alpha is None else alpha
        return np.dstack([panel, (np.clip(alpha, 0, 1) * 255).astype(np.uint8)])

    def marker_layers_rgba(self) -> dict[str, np.ndarray]:
        def rgba(rgb: np.ndarray, a: np.ndarray) -> np.ndarray:
            return np.dstack([np.clip(rgb, 0, 255).astype(np.uint8), (np.clip(a, 0, 1) * 255).astype(np.uint8)])
        g_rgb, g_a = self.m_glow
        return {"shadow": rgba(*self.m_shadow), "glow": rgba(g_rgb, g_a * PULSE_GLOW_MAX), "body": rgba(*self.m_body)}


def _png_data_url(bgra: np.ndarray) -> str:
    ok, buf = cv2.imencode(".png", bgra)
    return "data:image/png;base64," + base64.b64encode(buf.tobytes()).decode()


def show_windows(floors: list[dict]) -> list[tuple[float | None, float | None]]:
    """Per floor (show_start, show_end) in seconds; None = from the video start / to its end."""
    def num(v):
        return None if v in (None, "") else float(v)
    return [(num(f.get("show_start")), num(f.get("show_end"))) for f in floors]


def rooms_by_floor(rooms: list[dict], floor_ids: list[str]) -> list[list[dict]]:
    return [[r for r in rooms if r.get("floor") == fid] for fid in floor_ids]


def minimap_for_frame(plans, labels, settings, title, frame_w, frame_h, rooms=None, edits=None) -> Minimap:
    mm = Minimap(plans, labels, settings, title, settings["size"] * frame_w, settings["max_height"] * frame_h, rooms, edits)
    mm.place(frame_w, frame_h)
    return mm


def build_preview(plans, labels, settings, title, frame_w, frame_h, rooms=None, edits=None) -> dict:
    """Everything the browser needs to draw a pixel-identical live preview."""
    settings = merged_settings(settings)
    mm = minimap_for_frame(plans, labels, settings, title, frame_w, frame_h, rooms, edits)
    return {
        "frame": [frame_w, frame_h],
        "x0": mm.x0, "y0": mm.y0, "w": mm.w, "h": mm.h,
        "floors": [{"ox": ox, "oy": oy, "scale": sc, "image": _png_data_url(mm.rgba(i))} for i, (ox, oy, sc) in enumerate(mm.fits)],
        "marker": {"half": mm.m_half, "glow": bool(settings["glow"]),
                   "pulse": {"period": PULSE_PERIOD, "min": PULSE_MIN, "steps": PULSE_STEPS},
                   "images": {k: _png_data_url(v) for k, v in mm.marker_layers_rgba().items()}},
    }


def _ffmpeg_proc(args: list[str], log_path: Path, stdout=None) -> subprocess.Popen:
    log = open(log_path, "ab")
    return subprocess.Popen([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", *args],
                            stdin=subprocess.PIPE, stdout=stdout, stderr=log)


def safe_label(label: str, i: int) -> str:
    keep = "".join(c for c in label if c.isalnum() or c in "-_")
    return keep or f"floor{i + 1}"


def probe(video_path: Path) -> tuple[float, int, int, int]:
    cap = cv2.VideoCapture(str(video_path))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 1
    ok, first = cap.read()
    cap.release()
    if not ok:
        raise RuntimeError("영상을 읽을 수 없습니다")
    h, w = first.shape[:2]
    return fps, total, w - w % 2, h - h % 2  # even sizes for 4:2:0 encoders


OVERLAY_CODECS = {
    "prores": ["-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", "-vendor", "apl0"],
    "qtrle": ["-c:v", "qtrle", "-pix_fmt", "argb", "-g", "300"],
}


def render_outputs(
    video_path: Path,
    floors: list[dict],         # [{id, label, path, edits}]
    rooms: list[dict],          # room names on the plan
    path: list[dict],           # "③ 이동 지점": the points the marker passes, with arrival / departure times
    settings: dict,
    title: str,
    out_dir: Path,
    outputs: list[str],
    progress: Callable[[float, str], None] | None = None,
) -> list[str]:
    settings = merged_settings(settings)
    out_dir.mkdir(parents=True, exist_ok=True)
    plans = [load_plan(f["path"]) for f in floors]
    labels = [f.get("label", "") for f in floors]
    per_floor = rooms_by_floor(rooms, [f["id"] for f in floors])
    edits = [f.get("edits") or [] for f in floors]
    produced: list[str] = []
    log_path = out_dir / "ffmpeg.log"

    if "minimap" in outputs:
        # high-res styled plan per floor (transparent corners), for thumbnails / editing
        mm_hi = Minimap(plans, labels, settings, title, 1600, 10_000, per_floor, edits)
        # plain "promo mini plan": dark clean lines + room names on white, no board/texture/note
        clean = {**settings, "style": "chalk", "panel_color": "#ffffff", "panel_opacity": 1.0, "opacity": 1.0,
                 "line_color": "#2b2b2b", "chalk_texture": False, "show_note": False}
        mm_clean = Minimap(plans, labels, clean, title, 1600, 10_000, per_floor, edits)
        for i, lab in enumerate(labels):
            for prefix, m in (("minimap", mm_hi), ("plan", mm_clean)):
                name = f"{prefix}_{safe_label(lab, i)}.png"
                imwrite(out_dir / name, m.rgba(i))
                produced.append(name)

    if not any(o in outputs for o in ("composite", "overlay")):
        return produced

    fps, total, W, H = probe(video_path)
    times = np.arange(total) / fps
    track = compute_track(path, [f["id"] for f in floors], times, settings, show_windows(floors))
    if track is None:
        from .track import plan_only_track
        track = plan_only_track(times, show_windows(floors), settings)   # windows only, no marker
    if track is None:
        raise RuntimeError("이동 지점이 없습니다. ③ 이동 지점을 찍거나 층별 도면 노출 구간을 정해주세요")
    mm = minimap_for_frame(plans, labels, settings, title, W, H, per_floor, edits)
    # frame key: (plan on screen, marker x, y, marker alpha, glow level, plan alpha); no plan -> a blank frame
    keys = []
    for f, pf, x, y, a, t, pa in zip(track["floor"], track["pfloor"], track["x"], track["y"], track["alpha"], times, track["panel"]):
        if pf < 0 or pa <= 0:
            keys.append((0, 0.0, 0.0, 0.0, 1.0, 0.0))
            continue
        ma = float(a) if int(f) == int(pf) else 0.0          # the marker is on another floor: hidden
        keys.append((int(pf), round(float(x), 1), round(float(y), 1), round(ma, 2),
                     round(pulse_level(float(t)), 4) if settings["glow"] and ma > 0 else 1.0, round(float(pa), 2)))

    if "overlay" in outputs:
        name = "overlay.mov"
        _render_overlay(mm, keys, fps, total, W, H, OVERLAY_CODECS.get(settings["overlay_codec"], OVERLAY_CODECS["prores"]),
                        out_dir, out_dir / name, log_path,
                        (lambda p, m: progress(p * (0.5 if "composite" in outputs else 1), m)) if progress else None)
        produced.append(name)
    if "composite" in outputs:
        _render_composite(mm, keys, video_path, fps, total, W, H, out_dir / "composite.mp4", log_path,
                          (lambda p, m: progress((0.5 if "overlay" in outputs else 0) + p * (0.5 if "overlay" in outputs else 1), m))
                          if progress else None)
        produced.append("composite.mp4")
    return produced


def _render_overlay(mm, keys, fps, total, W, H, codec_args, out_dir, out_path, log_path, progress) -> None:
    """The marker rests most of the time, so render each distinct frame once as a PNG
    and let FFmpeg hold it for as long as it lasts (concat demuxer with durations)."""
    work = out_dir / "_frames"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir()
    try:
        runs: list[tuple[tuple, int, int]] = []  # (key, start, end)
        for i, k in enumerate(keys):
            if runs and runs[-1][0] == k:
                runs[-1] = (k, runs[-1][1], i + 1)
            else:
                runs.append((k, i, i + 1))

        files: dict[tuple, str] = {}
        buf = np.zeros((H, W, 4), np.uint8)
        for n, (k, _, _) in enumerate(runs):
            if k in files:
                continue
            panel, alpha = mm.draw(*k)
            buf[mm.y0 : mm.y0 + mm.h, mm.x0 : mm.x0 + mm.w] = mm.rgba(k[0], panel, alpha)
            files[k] = f"f{len(files):05d}.png"
            imwrite(work / files[k], buf, [cv2.IMWRITE_PNG_COMPRESSION, 1])
            if progress and n % 10 == 0:
                progress(0.3 * n / len(runs), f"미니맵 그리는 중 {n}/{len(runs)}")

        lines = ["ffconcat version 1.0"]
        for k, a, b in runs:
            lines += [f"file '{files[k]}'", f"duration {b / fps - a / fps:.6f}"]
        lines.append(f"file '{files[runs[-1][0]]}'")
        (work / "list.txt").write_text("\n".join(lines))

        rate = str(Fraction(fps).limit_denominator(1001))
        proc = _ffmpeg_proc(["-f", "concat", "-safe", "0", "-i", str(work / "list.txt"),
                             "-fps_mode", "cfr", "-r", rate, "-frames:v", str(total), *codec_args,
                             "-progress", "pipe:1", "-nostats", str(out_path)], log_path, stdout=subprocess.PIPE)
        proc.stdin.close()
        for line in proc.stdout:
            if progress and line.startswith(b"frame="):
                n = int(line.split(b"=")[1] or 0)
                progress(0.3 + 0.7 * min(1.0, n / total), f"인코딩 {n}/{total} 프레임")
        if proc.wait() != 0:
            raise RuntimeError("overlay.mov 인코딩 실패 (ffmpeg.log 확인)")
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _render_composite(mm, keys, video_path, fps, total, W, H, out_path, log_path, progress) -> None:
    proc = _ffmpeg_proc(
        ["-f", "rawvideo", "-s", f"{W}x{H}", "-r", f"{fps:.6f}", "-pix_fmt", "bgr24", "-i", "-", "-i", str(video_path),
         "-map", "0:v:0", "-map", "1:a:0?", "-c:v", "libx264", "-preset", "medium", "-crf", "18",
         "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", str(out_path)],
        log_path,
    )
    cap = cv2.VideoCapture(str(video_path))
    last_key, last = None, None
    i = 0
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            k = keys[min(i, len(keys) - 1)]
            if k != last_key:
                last, last_key = mm.draw(*k), k
            f = np.ascontiguousarray(frame[:H, :W])
            mm.composite(f, *last)
            proc.stdin.write(f.tobytes())
            i += 1
            if progress and i % 15 == 0:
                progress(min(0.99, i / total), f"합성 {i}/{total} 프레임")
    finally:
        cap.release()
        proc.stdin.close()
        code = proc.wait()
    if code != 0:
        raise RuntimeError("composite.mp4 인코딩 실패 (ffmpeg.log 확인)")
