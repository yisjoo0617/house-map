"""Turn a plan image into clean vector edits: straight walls, thin partitions / windows, doors, stairs.

Everything is analysed at the plan_structure working resolution (WORK_PX long side) and returned as
edits in plan-pixel coordinates, in the same format the drawing tools produce, tagged {"auto": true}.
The renderer draws these instead of the raw raster mask, so walls come out as straight lines with
clean corners rather than bumpy traced outlines.
"""
from __future__ import annotations

import math

import cv2
import numpy as np

AUTO_KINDS = ("walls", "thin", "doors", "stairs")


# ---------- straight strokes of one orientation ----------

def _open(mask: np.ndarray, w: int, h: int) -> np.ndarray:
    return cv2.morphologyEx(mask, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (max(1, w), max(1, h))))


def _bands(kept: np.ndarray, horizontal: bool, min_len: int) -> list[dict]:
    """Each connected piece of an already-opened mask -> a centre line.
    Thickness and position are medians over the columns (rows), so a blob of furniture stuck to a wall
    does not bend the line; columns that clearly belong to the blob are trimmed off the ends."""
    n, labels, stats, _ = cv2.connectedComponentsWithStats(kept, connectivity=8)
    out = []
    for i in range(1, n):
        x, y, w, h, area = (int(v) for v in stats[i])
        sub = labels[y:y + h, x:x + w] == i
        if not horizontal:
            sub = sub.T
            x, y, w, h = y, x, h, w
        cnt = sub.sum(axis=0)
        valid = cnt > 0
        centre = y + (np.arange(h)[:, None] * sub).sum(axis=0)[valid] / cnt[valid]
        t = float(np.median(cnt[valid]))
        c = float(np.median(centre))
        cols = np.arange(w)[valid]
        good = cols[(cnt[valid] <= 2.5 * t + 2) & (np.abs(centre - c) <= 0.75 * t + 1)]
        if good.size == 0:
            continue
        a0, a1 = x + int(good.min()), x + int(good.max()) + 1
        if a1 - a0 < min_len:
            continue
        spread = float(np.std(cnt[valid]) / max(t, 1.0))
        b = {"horiz": horizontal, "t": t, "len": float(a1 - a0), "cv": spread}
        if horizontal:
            b.update(x0=float(a0), x1=float(a1), y0=c, y1=c)
        else:
            b.update(x0=c, x1=c, y0=float(a0), y1=float(a1))
        out.append(b)
    return out


def _strokes(mask: np.ndarray, horizontal: bool, min_len: int, min_t: int = 1) -> list[dict]:
    kept = _open(mask, min_len, min_t) if horizontal else _open(mask, min_t, min_len)
    return _bands(kept, horizontal, min_len)


def _seg_len(s: dict) -> float:
    return math.hypot(s["x1"] - s["x0"], s["y1"] - s["y0"])


def _point_seg_dist(px: float, py: float, s: dict) -> float:
    ax, ay, bx, by = s["x0"], s["y0"], s["x1"], s["y1"]
    dx, dy = bx - ax, by - ay
    l2 = dx * dx + dy * dy
    u = 0.0 if l2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / l2))
    return math.hypot(px - (ax + u * dx), py - (ay + u * dy))


def _nearest_seg(px: float, py: float, segs: list[dict]) -> tuple[float, dict | None]:
    best, best_s = math.inf, None
    for s in segs:
        d = _point_seg_dist(px, py, s)
        if d < best:
            best, best_s = d, s
    return best, best_s


def _ends(s: dict):
    return (s["x0"], s["y0"]), (s["x1"], s["y1"])


def _touches(a: dict, b: dict, tol: float) -> bool:
    return any(_point_seg_dist(x, y, b) <= tol for x, y in _ends(a)) or any(_point_seg_dist(x, y, a) <= tol for x, y in _ends(b))


def _wall_groups(segs: list[dict], tol: float) -> list[list[dict]]:
    """Segments joined into groups through touching ends."""
    groups: list[list[dict]] = []
    for s in segs:
        hit = [g for g in groups if any(_touches(s, o, tol) for o in g)]
        merged = [s] + [o for g in hit for o in g]
        groups = [g for g in groups if g not in hit] + [merged]
    return groups


def _free_ends(s: dict, group: list[dict], tol: float) -> int:
    return sum(all(o is s or _point_seg_dist(x, y, o) > tol for o in group) for x, y in _ends(s))


def _pick_walls(bands: list[dict], W: int, ref: float) -> list[dict]:
    """Walls form one connected network anchored on the longest strokes. A freestanding stroke or
    group only counts when it is long and open (a dark sofa is a small closed loop; a bed edge is a
    short lone stroke). Short stubs sticking out of a wall with a free end are cabinet fronts, not walls."""
    tol = 1.3 * ref
    seeds = [b for b in bands if b["len"] >= 0.3 * W] or sorted(bands, key=lambda b: -b["len"])[:2]
    walls: list[dict] = []
    for g in _wall_groups(bands, tol):
        total = sum(b["len"] for b in g)
        open_ends = sum(_free_ends(b, g, tol) for b in g)
        if any(b in seeds for b in g) or (total >= 0.15 * W and open_ends > 0):
            walls += g
    while True:
        keep = []
        for s in walls:
            free = _free_ends(s, walls, tol)
            if free == 1 and s["len"] < 2.0 * ref and s["len"] < 0.3 * W:
                continue
            if free == 2 and s["len"] < 0.15 * W:
                continue
            keep.append(s)
        if len(keep) == len(walls):
            return keep
        walls = keep


def _merge_collinear(segs: list[dict], gap: float, off: float) -> list[dict]:
    """Join axis-aligned segments on the same line whose ends are within `gap`."""
    out: list[dict] = [s for s in segs if s.get("diag")]
    for horiz in (True, False):
        group = [s for s in segs if s["horiz"] == horiz and not s.get("diag")]
        a, b = ("x", "y") if horiz else ("y", "x")   # a = along, b = across
        group.sort(key=lambda s: min(s[a + "0"], s[a + "1"]))
        merged: list[dict] = []
        for s in group:
            lo, hi = sorted((s[a + "0"], s[a + "1"]))
            for m in merged:
                mlo, mhi = sorted((m[a + "0"], m[a + "1"]))
                if abs(m[b + "0"] - s[b + "0"]) <= off and lo <= mhi + gap and hi >= mlo - gap:
                    w1, w2 = max(1.0, mhi - mlo), max(1.0, hi - lo)
                    c = (m[b + "0"] * w1 + s[b + "0"] * w2) / (w1 + w2)
                    m[a + "0"], m[a + "1"] = min(lo, mlo), max(hi, mhi)
                    m[b + "0"] = m[b + "1"] = c
                    m["t"] = max(m["t"], s["t"])
                    m["len"] = m[a + "1"] - m[a + "0"]
                    break
            else:
                merged.append(dict(s))
        out += merged
    return out


def _dark_between(mask: np.ndarray | None, p: tuple, q: tuple) -> bool:
    if mask is None:
        return False
    n = max(2, int(math.hypot(q[0] - p[0], q[1] - p[1])))
    xs = np.clip(np.linspace(p[0], q[0], n).round().astype(int), 0, mask.shape[1] - 1)
    ys = np.clip(np.linspace(p[1], q[1], n).round().astype(int), 0, mask.shape[0] - 1)
    return mask[ys, xs].mean() >= 0.7


def _snap_corners(segs: list[dict], others: list[dict], tol: float, mask: np.ndarray | None = None, far: float = 0.0) -> None:
    """Pull each end of `segs` onto the crossing with the nearest perpendicular segment of `others`,
    so corners and T-joints meet exactly (a raster corner's half-thickness overshoot disappears).
    An end up to `far` away still snaps when the stroke visibly continues to that crossing in `mask`."""
    for _ in range(2):   # a second pass lets ends meet segments that were extended in the first
        for s in segs:
            if s.get("diag"):
                continue
            for end in ("0", "1"):
                px, py = s["x" + end], s["y" + end]
                best = None
                for o in others:
                    if o is s or o.get("diag") or o["horiz"] == s["horiz"]:
                        continue
                    if s["horiz"]:  # o is vertical at x = o.x0
                        d, on, cand = abs(o["x0"] - px), min(o["y0"], o["y1"]) - tol <= py <= max(o["y0"], o["y1"]) + tol, (o["x0"], py)
                    else:
                        d, on, cand = abs(o["y0"] - py), min(o["x0"], o["x1"]) - tol <= px <= max(o["x0"], o["x1"]) + tol, (px, o["y0"])
                    if not on or (best is not None and d >= best[0]):
                        continue
                    if d <= tol or (d <= far and _dark_between(mask, (px, py), cand)):
                        best = (d, cand)
                if best:
                    s["x" + end], s["y" + end] = best[1]
            s["len"] = _seg_len(s)


def _line_edit(s: dict, k: float, thin: bool = False) -> dict:
    e = {"type": "line", "pts": [[round(s["x0"] / k, 1), round(s["y0"] / k, 1)], [round(s["x1"] / k, 1), round(s["y1"] / k, 1)]],
         "auto": True}
    if thin:
        e["thin"] = True
    return e


# ---------- walls ----------

def _reference_thickness(bands: list[dict], W: int) -> float:
    """Typical wall thickness: length-weighted median over the long, clean bands (usually the outer walls)."""
    clean = [b for b in bands if b["len"] >= 0.15 * W and b["cv"] <= 0.35] or [b for b in bands if b["len"] >= 0.15 * W] or bands
    if not clean:
        return 0.0
    ts = np.array([b["t"] for b in clean])
    ws = np.array([b["len"] for b in clean])
    order = np.argsort(ts)
    cum = np.cumsum(ws[order])
    return float(ts[order][np.searchsorted(cum, cum[-1] / 2)])


def _diagonal_walls(mask: np.ndarray, min_len: int, t_lo: float, t_hi: float) -> list[dict]:
    """Straight strokes that are neither horizontal nor vertical (rare, but a slanted wall must not vanish)."""
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    out = []
    for i in range(1, n):
        if max(stats[i, 2], stats[i, 3]) < min_len:
            continue
        pts = np.column_stack(np.where(labels == i))[:, ::-1].astype(np.float32)
        (cx, cy), (rw, rh), ang = cv2.minAreaRect(pts)
        long, short = max(rw, rh), min(rw, rh)
        if long < min_len or not (t_lo <= short <= t_hi) or len(pts) < 0.7 * long * short:
            continue
        a = math.radians(ang if rw >= rh else ang + 90)
        if min(abs(math.sin(a)), abs(math.cos(a))) < 0.12:   # near axis-aligned: the band pass should have found it
            continue
        dx, dy = math.cos(a) * long / 2, math.sin(a) * long / 2
        out.append({"horiz": False, "diag": True, "t": short, "len": long, "cv": 0.0,
                    "x0": cx - dx, "y0": cy - dy, "x1": cx + dx, "y1": cy + dy})
    return out


def detect_walls(dark: np.ndarray, W: int) -> tuple[list[dict], float, np.ndarray]:
    """(wall segments, reference thickness, mask of the wall strokes), in work pixels."""
    min_len = int(0.04 * W)
    probe = _strokes(dark, True, min_len) + _strokes(dark, False, min_len)
    ref = _reference_thickness(probe, W)
    if ref <= 0:
        return [], 0.0, np.zeros_like(dark)
    t_min = max(3, int(round(0.35 * ref)))
    # only strokes at least t_min thick and min_len long survive: thin lines, textures and text are gone
    kept_h, kept_v = _open(dark, min_len, t_min), _open(dark, t_min, min_len)
    bands = [b for b in _bands(kept_h, True, min_len) + _bands(kept_v, False, min_len) if b["t"] <= 1.4 * ref]
    rest = dark.copy()
    rest[(kept_h > 0) | (kept_v > 0)] = 0
    rest = _open(rest, 3, 3)
    bands += _diagonal_walls(rest, int(0.08 * W), t_min, 1.4 * ref)
    bands = _merge_collinear(bands, gap=1.5 * ref, off=0.6 * ref)
    walls = _pick_walls(bands, W, ref)
    _snap_corners(walls, walls, tol=1.3 * ref, mask=dark, far=3.0 * ref)
    walls = [s for s in walls if _seg_len(s) >= 1.5 * ref]
    wall_mask = np.zeros_like(dark)
    for s in walls:
        cv2.line(wall_mask, (int(s["x0"]), int(s["y0"])), (int(s["x1"]), int(s["y1"])), 1, int(s["t"] + 2))
    return walls, ref, wall_mask


# ---------- thin partitions and windows ----------

def detect_thin(dark: np.ndarray, walls: list[dict], wall_mask: np.ndarray, ref: float, W: int) -> list[dict]:
    """Thin straight strokes that span between walls (glass partitions, bathroom screens, low walls).
    Furniture edges of similar darkness float free inside rooms and are dropped."""
    if not walls:
        return []
    thin_max = max(0.3 * ref, 0.004 * W)
    m = dark.copy()
    m[cv2.dilate(wall_mask, np.ones((3, 3), np.uint8), iterations=max(1, int(0.3 * ref))) > 0] = 0
    L = int(0.06 * W)
    tol = 1.0 * ref
    keep = []
    for s in _strokes(m, True, L) + _strokes(m, False, L):
        if not (1.5 <= s["t"] <= thin_max) or s["cv"] > 0.6:
            continue
        if all(_nearest_seg(x, y, walls)[0] <= tol for x, y in _ends(s)):
            keep.append(s)
    keep = _merge_collinear(keep, gap=1.0 * ref, off=0.5 * ref)
    _snap_corners(keep, walls, tol=1.5 * ref)
    return keep


def detect_windows(walls: list[dict], doors: list[dict], ref: float, W: int) -> list[dict]:
    """Openings in the outer walls that are not doors are windows (or glass): bridge them with a thin line.
    Each side of the plan's outline is walked from anchor to anchor; an anchor is a wall segment lying on
    that side or the corner where a perpendicular wall reaches it."""
    if not walls:
        return []
    xs = [v for s in walls for v in (s["x0"], s["x1"])]
    ys = [v for s in walls for v in (s["y0"], s["y1"])]
    x_lo, x_hi, y_lo, y_hi = min(xs), max(xs), min(ys), max(ys)
    edge = 2.0 * ref
    hinges = [(d["hx"], d["hy"]) for d in doors]
    out = []
    for horiz in (True, False):
        a, b = ("x", "y") if horiz else ("y", "x")
        for line in ((y_lo, y_hi) if horiz else (x_lo, x_hi)):
            spans = []   # (start, end, across, is a wall lying on this side) intervals covered along this side
            for s in walls:
                if s.get("diag"):
                    continue
                if s["horiz"] == horiz and abs(s[b + "0"] - line) <= edge:
                    lo, hi = sorted((s[a + "0"], s[a + "1"]))
                    spans.append((lo, hi, s[b + "0"], True))
                elif s["horiz"] != horiz:
                    for end in ("0", "1"):
                        if abs(s[b + end] - line) <= edge:      # a perpendicular wall reaches this side
                            spans.append((s[a + end], s[a + end], s[b + end], False))
            spans.sort()
            reach, reach_c, reach_wall = None, None, False
            for lo, hi, c, is_wall in spans:
                if reach is not None and lo - reach > 1.0 * ref and lo - reach <= 0.8 * W and abs(c - reach_c) <= 1.0 * ref:
                    # the window sits on the wall's own centre line; a perpendicular wall's end may overshoot
                    # the outline by half a thickness and must not pull the window line outward
                    cc = c if is_wall and not reach_wall else reach_c if reach_wall and not is_wall else (c + reach_c) / 2
                    p0 = (reach, cc) if horiz else (cc, reach)
                    p1 = (lo, cc) if horiz else (cc, lo)
                    if not any(math.hypot(hx - q[0], hy - q[1]) <= 1.5 * ref for hx, hy in hinges for q in (p0, p1)):
                        out.append({"horiz": horiz, "t": 1.0, "len": lo - reach, "cv": 0.0,
                                    "x0": p0[0], "y0": p0[1], "x1": p1[0], "y1": p1[1]})
                if reach is None or hi > reach:
                    reach, reach_c, reach_wall = hi, c, is_wall
    return out


def _trim_overshoot(walls: list[dict], windows: list[dict], ref: float) -> None:
    """A wall end that pokes past the plan's outline where a window bridges the gap (no perpendicular wall
    there to snap to) is pulled back onto the window line, so nothing sticks out of the outer border."""
    if windows:
        _snap_corners(walls, windows, tol=1.5 * ref)


# ---------- stairs ----------

def _local_lines(gray: np.ndarray, W: int) -> np.ndarray:
    """Pixels darker than their surroundings: thin lines of any shade, independent of the floor colour."""
    block = int(0.04 * W) | 1
    return cv2.adaptiveThreshold(gray, 1, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, block, 18)


def detect_stairs(gray: np.ndarray, lines: np.ndarray, ref: float, W: int) -> list[dict]:
    """Runs of 4+ evenly spaced parallel short lines with lighter treads between them."""
    L = int(0.035 * W)
    out = []
    for horiz in (True, False):
        runs = [b for b in _strokes(lines, horiz, L) if b["t"] <= max(3.0, 0.5 * ref) and L <= b["len"] <= 0.3 * W]
        a0, a1, bk = ("x0", "x1", "y0") if horiz else ("y0", "y1", "x0")
        runs.sort(key=lambda b: b[bk])
        used = [False] * len(runs)
        for i, r in enumerate(runs):
            if used[i]:
                continue
            chain, gaps = [r], []
            while True:
                last = chain[-1]
                nxt = None
                for j, c in enumerate(runs):
                    if used[j] or c is last or c[bk] <= last[bk] + 1:
                        continue
                    gap = c[bk] - last[bk]
                    if gap > 0.06 * W:
                        break
                    ov = min(last[a1], c[a1]) - max(last[a0], c[a0])
                    if ov < 0.6 * min(last["len"], c["len"]) or abs(c["len"] - last["len"]) > 0.4 * max(c["len"], last["len"]):
                        continue
                    if gaps and not (0.6 * np.median(gaps) <= gap <= 1.4 * np.median(gaps)):
                        continue
                    nxt = (j, c, gap)
                    break
                if not nxt:
                    break
                used[nxt[0]] = True
                chain.append(nxt[1])
                gaps.append(nxt[2])
            if len(chain) < 4:
                continue
            # treads between the lines must be clearly lighter than the lines (a herringbone floor or
            # a row of cabinet fronts is not a staircase)
            lo, hi = max(c[a0] for c in chain), min(c[a1] for c in chain)
            light = 0
            for p, q in zip(chain, chain[1:]):
                s0, s1 = int(p[bk] + p["t"]), int(q[bk] - q["t"])
                if s1 <= s0:
                    continue
                strip = gray[s0:s1, int(lo):int(hi)] if horiz else gray[int(lo):int(hi), s0:s1]
                line = gray[int(p[bk] - p["t"] / 2):int(p[bk] + p["t"] / 2) + 1, int(lo):int(hi)] if horiz \
                    else gray[int(lo):int(hi), int(p[bk] - p["t"] / 2):int(p[bk] + p["t"] / 2) + 1]
                light += strip.size > 0 and line.size > 0 and np.median(strip) > 150 and np.median(strip) > np.median(line) + 30
            if light < 0.75 * (len(chain) - 1):
                continue
            g = float(np.median(gaps))
            used[i] = True
            first, last = chain[0][bk] - g / 2, chain[-1][bk] + g / 2
            box = (min(c[a0] for c in chain), first, max(c[a1] for c in chain), last)
            if not horiz:
                box = (first, box[0], last, box[2])
            out.append({"box": box, "steps": len(chain) + 1, "horiz": horiz, "gap": g})
    return _join_flights(out)


def _join_flights(flights: list[dict]) -> list[dict]:
    """Two runs of the same orientation that continue each other (same width, small gap) are one flight."""
    flights = sorted(flights, key=lambda f: (f["horiz"], f["box"][1] if f["horiz"] else f["box"][0]))
    out: list[dict] = []
    for f in flights:
        for m in out:
            if m["horiz"] != f["horiz"]:
                continue
            a, b = (0, 2) if f["horiz"] else (1, 3)     # across-range indices (x for horizontal step lines)
            c, d = (1, 3) if f["horiz"] else (0, 2)     # along-range indices
            ov = min(m["box"][b], f["box"][b]) - max(m["box"][a], f["box"][a])
            width = min(m["box"][b] - m["box"][a], f["box"][b] - f["box"][a])
            gap = f["box"][c] - m["box"][d]
            if ov >= 0.7 * width and -0.5 * m["gap"] <= gap <= 1.5 * m["gap"] and abs(m["gap"] - f["gap"]) <= 0.5 * m["gap"]:
                box = list(m["box"])
                box[a], box[b] = min(m["box"][a], f["box"][a]), max(m["box"][b], f["box"][b])
                box[d] = f["box"][d]
                m["box"] = tuple(box)
                m["steps"] = int(round((box[d] - box[c]) / ((m["gap"] + f["gap"]) / 2)))
                break
        else:
            out.append(dict(f))
    return out


# ---------- doors ----------

def _fit_circle(pts: np.ndarray) -> tuple[float, float, float]:
    x, y = pts[:, 0], pts[:, 1]
    A = np.column_stack([x, y, np.ones_like(x)])
    b = x * x + y * y
    sol, *_ = np.linalg.lstsq(A, b, rcond=None)
    cx, cy = sol[0] / 2, sol[1] / 2
    r = math.sqrt(max(0.0, sol[2] + cx * cx + cy * cy))
    return float(cx), float(cy), r


def detect_doors(lines: np.ndarray, walls: list[dict], wall_mask: np.ndarray, ref: float, W: int) -> list[dict]:
    """Quarter-circle swing arcs whose centre sits on a wall: the classic door symbol."""
    if not walls:
        return []
    L = int(0.06 * W)
    m = lines.copy()
    m[cv2.dilate(wall_mask, np.ones((3, 3), np.uint8)) > 0] = 0
    straight = cv2.dilate(_open(m, L, 1) | _open(m, 1, L), np.ones((3, 3), np.uint8))
    m[straight > 0] = 0
    n, labels, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    out = []
    for i in range(1, n):
        x, y, w, h, area = (int(v) for v in stats[i])
        ext = max(w, h)
        if not (0.025 * W <= ext <= 0.2 * W) or min(w, h) < 0.45 * ext:
            continue
        pts = np.column_stack(np.where(labels == i))[:, ::-1].astype(np.float64)
        if len(pts) < 20:
            continue
        # iterate the fit so a bit of the door leaf or a wall stub stuck to the arc does not spoil it
        cx, cy, r = _fit_circle(pts)
        for _ in range(2):
            d = np.hypot(pts[:, 0] - cx, pts[:, 1] - cy)
            inl = pts[np.abs(d - r) <= 0.15 * r]
            if len(inl) < 20:
                break
            cx, cy, r = _fit_circle(inl)
        d = np.hypot(pts[:, 0] - cx, pts[:, 1] - cy)
        inl = pts[np.abs(d - r) <= 0.15 * r]
        if not (0.02 * W <= r <= 0.15 * W) or len(inl) < 0.6 * len(pts) or len(inl) < 20:
            continue
        ang = np.sort(np.degrees(np.arctan2(inl[:, 1] - cy, inl[:, 0] - cx)))
        gaps = np.diff(np.r_[ang, ang[0] + 360])
        j = int(np.argmax(gaps))
        span = 360 - gaps[j]
        if not (55 <= span <= 125):
            continue
        a_lo, a_hi = ang[(j + 1) % len(ang)], ang[j]
        arc_len = math.radians(span) * r
        if not (0.5 * arc_len <= len(inl) <= arc_len * (0.5 * ref + 3)):
            continue
        dist, wall = _nearest_seg(cx, cy, walls)
        if wall is None or dist > 1.2 * ref or wall.get("diag"):
            continue
        # hinge on the wall's centre line; the leaf swings exactly 90 degrees out of the wall
        if wall["horiz"]:
            hx, hy, ux, uy = cx, wall["y0"], 1.0, 0.0
        else:
            hx, hy, ux, uy = wall["x0"], cy, 0.0, 1.0
        nx, ny = -uy, ux
        e1 = (cx + r * math.cos(math.radians(a_lo)), cy + r * math.sin(math.radians(a_lo)))
        e2 = (cx + r * math.cos(math.radians(a_hi)), cy + r * math.sin(math.radians(a_hi)))
        across = [abs((e[0] - hx) * nx + (e[1] - hy) * ny) for e in (e1, e2)]   # distance from the wall line
        if min(across) > 1.5 * ref or max(across) < 0.5 * r:
            continue
        closed, tip = (e1, e2) if across[0] <= across[1] else (e2, e1)
        sign_u = 1.0 if (closed[0] - hx) * ux + (closed[1] - hy) * uy >= 0 else -1.0
        sign_n = 1.0 if (tip[0] - hx) * nx + (tip[1] - hy) * ny >= 0 else -1.0
        # a wall end across the opening at about the arc radius -> the door fills the opening exactly
        for o in walls:
            for ex, ey in _ends(o):
                along = ((ex - hx) * ux + (ey - hy) * uy) * sign_u
                off = abs((ex - hx) * nx + (ey - hy) * ny)
                if off <= 0.8 * ref and 0.7 * r <= along <= 1.3 * r:
                    r = along
        end = (hx + sign_n * nx * r, hy + sign_n * ny * r)
        a_end = math.degrees(math.atan2(end[1] - hy, end[0] - hx))
        a_closed = math.degrees(math.atan2(sign_u * uy, sign_u * ux))
        diff = (a_closed - a_end + 180) % 360 - 180
        out.append({"hx": hx, "hy": hy, "ex": end[0], "ey": end[1], "r": r, "flip": diff < 0})
    return out


# ---------- public ----------

def _chroma(big: np.ndarray) -> np.ndarray:
    """Colourfulness as an absolute difference (HSV saturation explodes on dark, noisy pixels)."""
    return big.max(axis=2).astype(np.int16) - big.min(axis=2).astype(np.int16)


def auto_edits(plan: np.ndarray, settings: dict, kinds=AUTO_KINDS) -> list[dict]:
    """All automatic vector edits of a plan (plan pixels), tagged "auto"."""
    from .render import plan_structure, work_image  # render imports this module

    mode = settings["line_mode"]
    if mode == "none" or not kinds:
        return []
    k, big = work_image(plan)
    W = max(big.shape[:2])
    gray = cv2.cvtColor(big, cv2.COLOR_BGR2GRAY)
    if mode == "structure":
        # rendered plans: walls are dark and colourless. Looser than the raster mask (which must not
        # let furniture through) because only long, thick, connected straight strokes become walls here.
        dark = (gray < float(settings["line_threshold"]) * 0.8) & (_chroma(big) < 25)
        dark = dark.astype(np.uint8)
    else:
        dark = plan_structure(plan, settings, [])["mask"]

    walls, ref, wall_mask = detect_walls(dark, W)
    lines = _local_lines(gray, W)
    doors = detect_doors(lines, walls, wall_mask, ref, W) if "doors" in kinds else []
    out: list[dict] = []
    thin = detect_thin(dark, walls, wall_mask, ref, W) if "thin" in kinds else []
    windows = detect_windows(walls, doors, ref, W)
    _trim_overshoot(walls, windows, ref)
    if "walls" in kinds:
        out += [_line_edit(s, k) for s in walls]
    if "thin" in kinds:
        out += [_line_edit(s, k, thin=True) for s in thin + windows]
    for d in doors:
        out.append({"type": "door", "hinge": [round(d["hx"] / k, 1), round(d["hy"] / k, 1)],
                    "end": [round(d["ex"] / k, 1), round(d["ey"] / k, 1)], "flip": d["flip"], "auto": True})
    if "stairs" in kinds:
        for s in detect_stairs(gray, lines, ref, W):
            x0, y0, x1, y1 = s["box"]
            # the renderer draws the step lines across the long side unless flipped
            flip = ((y1 - y0) >= (x1 - x0)) != s["horiz"]
            out.append({"type": "stairs", "a": [round(x0 / k, 1), round(y0 / k, 1)], "b": [round(x1 / k, 1), round(y1 / k, 1)],
                        "steps": s["steps"], "flip": flip, "auto": True})
    return out
