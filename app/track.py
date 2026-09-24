"""Marker track from the moves set in "③ 이동 지점".

A move is a start point and an end point placed anywhere on a floor plan, each with its own time:
{id, a: {floor, x, y}, b: {floor, x, y}, t0, t1, via?: [[x, y], ...], mode?: "walk" | "jump"}.
The marker leaves a at t0 and arrives at b exactly at t1, so its speed follows from the two times.
On one floor it walks in straight legs through the bend points ("via", set in ④ 경로 꺾기); across
floors, or with mode="jump", it fades out at a and back in at b. Between moves it rests where the last
move ended, and when the next move starts somewhere else it fades over to that start point just before t0.

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


def _pos(p: dict) -> dict:
    return {"floor": p["floor"], "x": float(p["x"]), "y": float(p["y"])}


def _same(p: dict, q: dict) -> bool:
    return p["floor"] == q["floor"] and abs(p["x"] - q["x"]) < 0.5 and abs(p["y"] - q["y"]) < 0.5


def clean_moves(moves: list[dict] | None, floor_ids: list[str]) -> list[dict]:
    """Complete moves (both points on known floors, t1 after t0), in start-time order."""
    out = []
    for m in moves or []:
        a, b = m.get("a"), m.get("b")
        if not a or not b or m.get("t0") in (None, "") or m.get("t1") in (None, ""):
            continue
        if a.get("floor") not in floor_ids or b.get("floor") not in floor_ids:
            continue
        try:
            t0, t1 = float(m["t0"]), float(m["t1"])
            pa, pb = _pos(a), _pos(b)
            via = [(float(q[0]), float(q[1])) for q in (m.get("via") or []) if len(q) == 2]
        except (KeyError, TypeError, ValueError):
            continue
        if t1 <= t0:
            continue
        out.append({"id": m.get("id"), "a": pa, "b": pb, "t0": t0, "t1": t1, "via": via,
                    "mode": "jump" if m.get("mode") == "jump" else "walk"})
    out.sort(key=lambda m: m["t0"])
    return out


def initial_pose(moves: list[dict] | None, floor_ids: list[str]) -> dict | None:
    """Where the marker is before anything happens: the first move's start point."""
    clean = clean_moves(moves, floor_ids)
    return clean[0]["a"] if clean else None


def plan_moves(moves: list[dict] | None, floor_ids: list[str], settings: dict | None = None) -> list[dict]:
    """Each move as {id, t, start, end, from, to, poly, kind}; a fade-over to a start point the marker is not
    at yet is an extra {kind: fade, hop: True} entry just before it."""
    settings = settings or {}
    fade = float(settings.get("fade_sec", 0.6))
    out = []
    prev_end = -np.inf
    cur = None   # where the marker is after the moves planned so far
    for m in clean_moves(moves, floor_ids):
        a, b = m["a"], m["b"]
        if cur is None:
            cur = a
        if not _same(cur, a):
            # the marker is somewhere else: fade over to the start point just before it leaves
            start, end = max(prev_end, m["t0"] - fade), m["t0"]
            if end > start:
                out.append({"id": m["id"], "t": m["t0"], "start": start, "end": end, "from": cur, "to": a,
                            "poly": np.asarray([(cur["x"], cur["y"]), (a["x"], a["y"])], float), "kind": "fade", "hop": True})
        # the user set both times, so they win: leave exactly at t0 and arrive exactly at t1
        walk = a["floor"] == b["floor"] and m["mode"] == "walk"
        poly = [(a["x"], a["y"]), *(m["via"] if walk else []), (b["x"], b["y"])]
        out.append({"id": m["id"], "t": m["t0"], "start": m["t0"], "end": m["t1"], "from": a, "to": b,
                    "poly": np.asarray(poly, float), "kind": "walk" if walk else "fade"})
        prev_end = m["t1"]
        cur = b
    return out


def compute_track(
    moves: list[dict] | None,
    floor_ids: list[str],
    times: np.ndarray,
    settings: dict | None = None,
    windows: list[tuple[float | None, float | None]] | None = None,   # per floor: (show start, show end)
) -> dict | None:
    """Per-time floor index, x, y, marker opacity and panel opacity (or None if there is no complete move)."""
    settings = settings or {}
    first = initial_pose(moves, floor_ids)
    if first is None:
        return None
    planned = plan_moves(moves, floor_ids, settings)
    times = np.asarray(times, dtype=float)
    fidx = {f: i for i, f in enumerate(floor_ids)}

    x = np.full(len(times), float(first["x"]))
    y = np.full(len(times), float(first["y"]))
    floor = np.full(len(times), fidx[first["floor"]], dtype=int)
    alpha = np.ones(len(times))

    for m in planned:
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
            k = np.abs(u - 0.5) * 2  # 1 -> 0 -> 1
            alpha[sel] = k * k * (3 - 2 * k)
    info = [{"id": m["id"] or "", "t": m["t"], "start": m["start"], "end": m["end"], "kind": m["kind"],
             **({"hop": True} if m.get("hop") else {})} for m in planned]
    pfloor, panel = panel_plan(times, floor, windows or [], float(settings.get("panel_fade_sec", 0.6)))
    return {"t": times, "floor": floor, "x": x, "y": y, "alpha": alpha, "pfloor": pfloor, "panel": panel, "moves": info}


def plan_only_track(times: np.ndarray, windows: list[tuple[float | None, float | None]], settings: dict | None = None) -> dict | None:
    """With no moves there is no marker, but floors with a show window can still be on screen.
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
