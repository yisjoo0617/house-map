"""Walking routes between rooms that go around walls (through door openings) instead of through them.

The plan's walls (automatic detection + drawn lines, minus eraser strokes) become obstacles on a coarse
grid; a least-cost route prefers the middle of corridors and doorways, then gets simplified and rounded.
If the walls leave no opening, the route crosses the thinnest wall rather than failing.
"""
from __future__ import annotations

import math

import cv2
import numpy as np
from skimage.graph import route_through_array

from .render import draw_edits, plan_structure

GRID_PX = 320        # long side of the routing grid
WALL_COST = 5000.0   # crossing a wall is possible but very expensive (missing openings degrade gracefully)

_grid_cache: dict[tuple, tuple] = {}
_route_cache: dict[tuple, list] = {}


def _grid(plan: np.ndarray, settings: dict, edits: list[dict]) -> tuple[np.ndarray, float]:
    key = (plan.shape, int(plan[::7, ::7].sum()), settings["line_threshold"], settings["line_mode"], repr(edits))
    if key in _grid_cache:
        return _grid_cache[key]
    ph, pw = plan.shape[:2]
    g = GRID_PX / max(ph, pw)  # plan px -> grid px
    gw, gh = max(2, round(pw * g)), max(2, round(ph * g))

    st = plan_structure(plan, settings, edits)
    walls = cv2.resize(st["mask"].astype(np.float32), (gw, gh), interpolation=cv2.INTER_AREA) > 0.08
    walls = walls.astype(np.uint8)
    # drawn lines (normal and thin) are walls/partitions too; doors, stairs and fixtures are walkable
    draw_edits(walls, [e for e in edits if e.get("type") == "line"], g, value=1, thickness=2)

    free = (walls == 0).astype(np.uint8)
    dist = cv2.distanceTransform(free, cv2.DIST_L2, 3)
    # hug the middle of corridors: cost falls off with distance from the nearest wall
    cost = 1.0 + 6.0 / (1.0 + dist)
    cost[walls > 0] = WALL_COST
    res = (cost.astype(np.float64), g)
    if len(_grid_cache) > 16:
        _grid_cache.clear()
    _grid_cache[key] = res
    return res


def route(plan: np.ndarray, settings: dict, edits: list[dict], a: tuple[float, float], b: tuple[float, float]) -> list[list[float]]:
    """Polyline (plan coordinates) from a to b that walks around walls."""
    if math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6:
        return [list(a), list(b)]
    key = (plan.shape, int(plan[::7, ::7].sum()), repr(edits), settings["line_threshold"], settings["line_mode"],
           tuple(np.round(a, 1)), tuple(np.round(b, 1)))
    if key in _route_cache:
        return _route_cache[key]

    cost, g = _grid(plan, settings, edits)
    gh, gw = cost.shape

    def cell(p):
        return (int(np.clip(round(p[1] * g), 0, gh - 1)), int(np.clip(round(p[0] * g), 0, gw - 1)))

    idx, _ = route_through_array(cost, cell(a), cell(b), fully_connected=True, geometric=True)
    pts = np.array([[c, r] for r, c in idx], np.float32)
    # simplify the staircase grid path, then round the corners a little
    simple = cv2.approxPolyDP(pts.reshape(-1, 1, 2), 1.2, False).reshape(-1, 2) if len(pts) > 2 else pts
    smooth = _chaikin(simple, 2)
    out = [list(a)] + [[float(x / g), float(y / g)] for x, y in smooth[1:-1]] + [list(b)]
    if len(_route_cache) > 512:
        _route_cache.clear()
    _route_cache[key] = out
    return out


def _chaikin(pts: np.ndarray, iterations: int) -> np.ndarray:
    for _ in range(iterations):
        if len(pts) < 3:
            return pts
        q = 0.75 * pts[:-1] + 0.25 * pts[1:]
        r = 0.25 * pts[:-1] + 0.75 * pts[1:]
        mid = np.empty((2 * len(q), 2), np.float32)
        mid[0::2], mid[1::2] = q, r
        pts = np.vstack([pts[:1], mid, pts[-1:]])
    return pts


def make_router(plans: dict[str, np.ndarray], settings: dict, edits: dict[str, list[dict]]):
    """router(floor_id, (x, y), (x, y)) -> polyline, or straight lines when path following is off."""
    def router(fid, a, b):
        if not settings.get("follow_path", True) or fid not in plans:
            return [list(a), list(b)]
        return route(plans[fid], settings, edits.get(fid, []), a, b)
    return router
