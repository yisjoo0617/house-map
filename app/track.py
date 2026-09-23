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

Router = Callable[[str, tuple, tuple], list]
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
            poly = np.asarray(router(a["floor"], pa, pb) if router else [pa, pb], float)
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
) -> dict | None:
    """Per-time floor index, x, y and marker opacity (or None if nothing is recorded)."""
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
    return {"t": times, "floor": floor, "x": x, "y": y, "alpha": alpha, "moves": info}
