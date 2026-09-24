"""Marker track from the path set in "③ 이동 지점".

The path is an ordered list of points on the floor plans. Consecutive points share nothing but their
order: the marker rests at point k from its arrival time until its departure time, then travels to
point k+1, arriving there at that point's arrival time. So the end of one leg and the start of the next
are always the same spot, and every departure / arrival time is the user's own.
    {id, floor, x, y, arrive, depart, via?: [[x, y], ...], mode?: "walk" | "jump"}
The first point is where the marker is from the video start ("arrive" unused). "via" and "mode" belong
to the leg INTO the point: on one floor the marker walks in straight legs through the bend points
(④ 경로 꺾기); across floors, or with mode="jump", it fades out at the previous point and back in here.

Missing times are filled in the least surprising way: no departure = leave the moment you arrived
(the first point: at 0), no arrival = arrive the moment you left (an instant jump). Legs never overlap.

Coordinates are plan-image pixels of the point's floor.
"""
from __future__ import annotations

import numpy as np


def _walk_profile(u: np.ndarray, ramp: float = 0.2) -> np.ndarray:
    """Progress 0..1 for time fraction u: speed up over the first `ramp`, walk, slow down over the last."""
    grid = np.linspace(0, 1, 201)
    v = np.minimum(1.0, np.minimum(grid / ramp, (1 - grid) / ramp)) + 1e-6
    s = np.concatenate([[0], np.cumsum((v[1:] + v[:-1]) / 2)])
    return np.interp(u, grid, s / s[-1])


def _along(poly: np.ndarray, frac: np.ndarray) -> np.ndarray:
    seg = np.linalg.norm(np.diff(poly, axis=0), axis=1)
    cum = np.concatenate([[0], np.cumsum(seg)])
    if cum[-1] < 1e-9:
        return np.repeat(poly[:1], len(frac), axis=0)
    d = frac * cum[-1]
    return np.stack([np.interp(d, cum, poly[:, 0]), np.interp(d, cum, poly[:, 1])], axis=1)


def _num(v) -> float | None:
    if v in (None, ""):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def clean_path(path: list[dict] | None, floor_ids: list[str]) -> list[dict]:
    """The path's points on known floors, in order, with numbers as floats (a dropped point joins its neighbours)."""
    out = []
    for q in path or []:
        if not isinstance(q, dict) or q.get("floor") not in floor_ids:
            continue
        try:
            x, y = float(q["x"]), float(q["y"])
        except (KeyError, TypeError, ValueError):
            continue
        via = [(float(v[0]), float(v[1])) for v in (q.get("via") or []) if len(v) == 2]
        out.append({"id": q.get("id"), "floor": q["floor"], "x": x, "y": y, "arrive": _num(q.get("arrive")),
                    "depart": _num(q.get("depart")), "via": via, "mode": "jump" if q.get("mode") == "jump" else "walk"})
    return out


def initial_pose(path: list[dict] | None, floor_ids: list[str]) -> dict | None:
    """Where the marker is before anything happens: the first point of the path."""
    pts = clean_path(path, floor_ids)
    return {"floor": pts[0]["floor"], "x": pts[0]["x"], "y": pts[0]["y"]} if pts else None


def plan_legs(path: list[dict] | None, floor_ids: list[str], settings: dict | None = None) -> list[dict]:
    """Each leg into point k (k >= 1) as {id (of point k), k, t, start, end, from, to, poly, kind}."""
    pts = clean_path(path, floor_ids)
    out = []
    prev_end = -np.inf
    for k in range(1, len(pts)):
        a, b = pts[k - 1], pts[k]
        start = a["depart"]
        if start is None:
            start = a["arrive"] if (k > 1 and a["arrive"] is not None) else (0.0 if k == 1 else prev_end)
        start = max(float(start), prev_end)          # legs never overlap
        end = b["arrive"] if b["arrive"] is not None else start
        end = max(float(end), start)                 # arriving before leaving = an instant jump
        walk = a["floor"] == b["floor"] and b["mode"] == "walk"
        poly = [(a["x"], a["y"]), *(b["via"] if walk else []), (b["x"], b["y"])]
        out.append({"id": b["id"] or "", "k": k, "t": start, "start": start, "end": end,
                    "from": {"floor": a["floor"], "x": a["x"], "y": a["y"]}, "to": {"floor": b["floor"], "x": b["x"], "y": b["y"]},
                    "poly": np.asarray(poly, float), "kind": "walk" if walk else "fade"})
        prev_end = end
    return out


def compute_track(
    path: list[dict] | None,
    floor_ids: list[str],
    times: np.ndarray,
    settings: dict | None = None,
    windows: list[tuple[float | None, float | None]] | None = None,   # per floor: (show start, show end)
) -> dict | None:
    """Per-time floor index, x, y, marker opacity and panel opacity (or None if the path is empty)."""
    settings = settings or {}
    first = initial_pose(path, floor_ids)
    if first is None:
        return None
    legs = plan_legs(path, floor_ids, settings)
    times = np.asarray(times, dtype=float)
    fidx = {f: i for i, f in enumerate(floor_ids)}

    x = np.full(len(times), float(first["x"]))
    y = np.full(len(times), float(first["y"]))
    floor = np.full(len(times), fidx[first["floor"]], dtype=int)
    alpha = np.ones(len(times))

    for m in legs:
        a, b = m["from"], m["to"]
        after = times >= m["end"]
        x[after], y[after] = float(b["x"]), float(b["y"])
        floor[after] = fidx[b["floor"]]
        if m["end"] <= m["start"]:
            continue
        sel = (times >= m["start"]) & (times < m["end"])
        u = (times[sel] - m["start"]) / (m["end"] - m["start"])
        if m["kind"] == "walk":
            xy = _along(m["poly"], _walk_profile(u))
            x[sel], y[sel] = xy[:, 0], xy[:, 1]
            floor[sel] = fidx[a["floor"]]
            alpha[sel] = 1.0
        else:
            # fade out at the old spot, switch while invisible, fade in at the new one
            first_half = u < 0.5
            idx = np.where(sel)[0]
            src, dst = idx[first_half], idx[~first_half]
            x[src], y[src], floor[src] = float(a["x"]), float(a["y"]), fidx[a["floor"]]
            x[dst], y[dst], floor[dst] = float(b["x"]), float(b["y"]), fidx[b["floor"]]
            kk = np.abs(u - 0.5) * 2  # 1 -> 0 -> 1
            alpha[sel] = kk * kk * (3 - 2 * kk)
    info = [{"id": m["id"], "k": m["k"], "t": m["t"], "start": m["start"], "end": m["end"], "kind": m["kind"]} for m in legs]
    pfloor, panel = panel_plan(times, floor, windows or [], float(settings.get("panel_fade_sec", 0.6)))
    return {"t": times, "floor": floor, "x": x, "y": y, "alpha": alpha, "pfloor": pfloor, "panel": panel, "moves": info}


def plan_only_track(times: np.ndarray, windows: list[tuple[float | None, float | None]], settings: dict | None = None) -> dict | None:
    """With no path there is no marker, but floors with a show window can still be on screen.
    Returns a track like compute_track's with the marker hidden everywhere, or None if no window is set."""
    settings = settings or {}
    if not any(w != (None, None) for w in windows):
        return None
    times = np.asarray(times, dtype=float)
    n = len(times)
    pfloor, panel = panel_plan(times, np.full(n, -1, dtype=int), windows, float(settings.get("panel_fade_sec", 0.6)))
    return {"t": times, "floor": np.full(n, -1, dtype=int), "x": np.zeros(n), "y": np.zeros(n), "alpha": np.zeros(n),
            "pfloor": pfloor, "panel": panel, "moves": []}


def panel_plan(times: np.ndarray, floor: np.ndarray, windows: list[tuple[float | None, float | None]],
               fade: float) -> tuple[np.ndarray, np.ndarray]:
    """Which plan is on screen per frame (-1 = none) and its opacity 0..1.

    A floor with a show window (start/end in seconds, None = video edge) is on screen exactly inside that
    window, whatever the marker does; if two windows overlap, the one that started last wins. A floor
    without a window is "automatic": it is on screen while the marker is on it and no window is active.
    The plan eases in/out over `fade` seconds whenever the plan on screen changes (not at the video edges).
    Only one plan is ever on screen, so two floors never show together."""
    n = len(times)
    pf = np.full(n, -1, dtype=int)
    auto = [i for i, w in enumerate(windows) if w == (None, None)] if windows else list(range(int(floor.max()) + 1))
    auto = [i for i in auto if i >= 0]
    on_auto = np.isin(floor, auto)
    pf[on_auto] = floor[on_auto]
    best_start = np.full(n, -np.inf)
    for i, (s0, e0) in enumerate(windows):
        if s0 is None and e0 is None:
            continue
        lo, hi = (-np.inf if s0 is None else float(s0)), (np.inf if e0 is None else float(e0))
        sel = (times >= lo) & (times < hi) & (lo >= best_start)
        pf[sel], best_start[sel] = i, lo
    # ease at every change of the plan on screen
    pa = np.where(pf >= 0, 1.0, 0.0)
    fade = max(float(fade), 1e-6)
    change = np.flatnonzero(np.diff(pf) != 0) + 1          # first index of each new run
    for k in change:
        t0 = times[k]
        if pf[k] >= 0:
            sel = (times >= t0) & (times < t0 + fade) & (pf == pf[k])
            pa[sel] = np.minimum(pa[sel], (times[sel] - t0) / fade)
        if pf[k - 1] >= 0:
            sel = (times < t0) & (times >= t0 - fade) & (pf == pf[k - 1])
            pa[sel] = np.minimum(pa[sel], (t0 - times[sel]) / fade)
    return pf, np.clip(pa, 0, 1)
