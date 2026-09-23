"""Room-level position track.

The user places rooms (points) on each floor plan and records *events*:
"at time t the camera enters room R". Between events the marker rests on the
room point; around each event it either walks from the previous room to the next one
along a route (see path.py) at a set speed, or fades out and back in at the new room
("jump": always used for floor changes). Each event may override the default with mode="walk"/"jump".

Coordinates are plan-image pixels of the room's floor.
"""
from __future__ import annotations

from typing import Callable

import numpy as np

Router = Callable[[str, tuple, tuple], list]   # kept for callers; None = straight lines
MAX_MOVE_SEC = 30.0


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


def clean_events(events: list[dict], rooms: dict[str, dict]) -> list[dict]:
    evs = sorted((e for e in events if e.get("room") in rooms and e.get("t") is not None), key=lambda e: float(e["t"]))
    out: list[dict] = []
    for e in evs:
        if out and out[-1]["room"] == e["room"]:
            continue  # re-entering the room you're already in changes nothing
        out.append(e)
    return out


def plan_moves(rooms: list[dict], events: list[dict], floor_ids: list[str], settings: dict,
               router: Router | None = None, floor_sizes: dict[str, float] | None = None) -> tuple[list[dict], list[dict], dict]:
    """Each room change as {start, end, from, to, poly} (start == end for jumps), plus the cleaned events and rooms."""
    by_id = {r["id"]: r for r in rooms if r.get("floor") in floor_ids}
    evs = clean_events(events, by_id)
    moves = []
    prev_end = -np.inf
    for i in range(1, len(evs)):
        a, b = by_id[evs[i - 1]["room"]], by_id[evs[i]["room"]]
        t = float(evs[i]["t"])
        pa, pb = (float(a["x"]), float(a["y"])), (float(b["x"]), float(b["y"]))
        same_floor = a["floor"] == b["floor"]
        mode = evs[i].get("mode") or ("walk" if settings.get("transition", "slide") == "slide" else "jump")
        kind = "walk" if (mode == "walk" and same_floor) else "fade"
        own = evs[i].get("sec")  # this one move's duration, set in the record table (None = follow the settings)
        if kind == "walk":
            # straight legs: room -> each bend point set in the plan editor ("via") -> room
            via = [(float(q[0]), float(q[1])) for q in (evs[i].get("via") or []) if len(q) == 2]
            poly = np.asarray(router(a["floor"], pa, pb) if router else [pa, *via, pb], float)
            length = float(np.linalg.norm(np.diff(poly, axis=0), axis=1).sum())
            if own is not None:
                dur = max(0.0, float(own))
            elif settings.get("move_timing", "speed") == "speed":
                # speed is set as "seconds to walk across the whole plan", so it means the same on any plan
                long_side = (floor_sizes or {}).get(a["floor"]) or 1000.0
                speed = long_side / max(0.2, float(settings.get("cross_sec", 4.0)))  # plan px / s
                dur = min(MAX_MOVE_SEC, length / speed)
            else:
                dur = float(settings.get("transition_sec", 0.8))
        else:
            poly = np.asarray([pa, pb], float)
            dur = max(0.0, float(own if own is not None else settings.get("fade_sec", 0.6)))

        anchor = settings.get("move_anchor", "center")
        start = t - dur / 2 if anchor == "center" else t if anchor == "start" else t - dur
        planned = start
        start = max(start, prev_end)  # never overlap the previous move
        end = start + dur
        prev_end = end
        moves.append({"t": t, "start": start, "end": end, "planned": planned, "from": a, "to": b, "poly": poly, "kind": kind})
    return moves, evs, by_id


def compute_room_track(
    rooms: list[dict],
    events: list[dict],
    floor_ids: list[str],
    times: np.ndarray,
    settings: dict | None = None,
    router: Router | None = None,
    floor_sizes: dict[str, float] | None = None,
    windows: list[tuple[float | None, float | None]] | None = None,   # per floor: (show start, show end)
) -> dict | None:
    """Per-time floor index, x, y, marker opacity and panel opacity (or None if nothing is recorded)."""
    settings = settings or {}
    moves, evs, by_id = plan_moves(rooms, events, floor_ids, settings, router, floor_sizes)
    if not evs:
        return None
    times = np.asarray(times, dtype=float)
    fidx = {f: i for i, f in enumerate(floor_ids)}

    first = by_id[evs[0]["room"]]
    x = np.full(len(times), float(first["x"]))
    y = np.full(len(times), float(first["y"]))
    floor = np.full(len(times), fidx[first["floor"]], dtype=int)
    alpha = np.ones(len(times))

    for m in moves:
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
        else:
            # fade out in the old room, switch while invisible, fade in at the new room
            first_half = u < 0.5
            idx = np.where(sel)[0]
            src, dst = idx[first_half], idx[~first_half]
            x[src], y[src], floor[src] = float(a["x"]), float(a["y"]), fidx[a["floor"]]
            x[dst], y[dst], floor[dst] = float(b["x"]), float(b["y"]), fidx[b["floor"]]
            k = np.abs(u - 0.5) * 2  # 1 -> 0 -> 1
            alpha[sel] = k * k * (3 - 2 * k)
    info = [{"t": m["t"], "start": m["start"], "end": m["end"], "delay": max(0.0, m["start"] - m["planned"]),
             "kind": m["kind"]} for m in moves]
    pfloor, panel = panel_plan(times, floor, windows or [], float(settings.get("panel_fade_sec", 0.6)))
    return {"t": times, "floor": floor, "x": x, "y": y, "alpha": alpha, "pfloor": pfloor, "panel": panel, "moves": info}


def plan_only_track(times: np.ndarray, windows: list[tuple[float | None, float | None]], settings: dict | None = None) -> dict | None:
    """With no room records there is no marker, but floors with a show window can still be on screen.
    Returns a track like compute_room_track's with the marker hidden everywhere, or None if no window is set."""
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
