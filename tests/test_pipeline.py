import math
import os
import subprocess
import sys
import tempfile
from pathlib import Path

# the API tests must never touch the real data/ folder
os.environ["HOUSEMAP_DATA"] = tempfile.mkdtemp(prefix="housemap-test-")

import cv2
import numpy as np
import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.motion import analyze_video  # noqa: E402
from app.render import Minimap, auto_trim, load_plan, merged_settings, render_outputs  # noqa: E402
from app.track import compute_track, plan_moves  # noqa: E402

SAMPLE = ROOT / "tests" / "sample"
ROOMS = [
    {"id": "a", "name": "거실", "floor": "f1", "x": 100, "y": 100},
    {"id": "b", "name": "주방", "floor": "f1", "x": 300, "y": 100},
    {"id": "c", "name": "안방", "floor": "f2", "x": 50, "y": 50},
]


@pytest.fixture(scope="session")
def sample():
    if not (SAMPLE / "walk.mp4").exists():
        subprocess.run([sys.executable, str(ROOT / "tests" / "make_sample.py"), str(SAMPLE)], check=True)
    return SAMPLE


def MV(a, b, t0, t1, **extra):
    """A move between two of ROOMS' positions (room ids) or explicit points."""
    pt = lambda r: {"floor": r["floor"], "x": r["x"], "y": r["y"]} if isinstance(r, dict) else next(
        {"floor": q["floor"], "x": q["x"], "y": q["y"]} for q in ROOMS if q["id"] == r)
    return {"id": f"{a if isinstance(a, str) else 'p'}-{b if isinstance(b, str) else 'p'}-{t0}", "a": pt(a), "b": pt(b), "t0": t0, "t1": t1, **extra}


def test_track_rests_then_walks_between_the_two_times():
    tr = compute_track([MV("a", "b", 4.0, 6.0)], ["f1", "f2"], np.array([0, 3.9, 4.0, 5.0, 6.0, 9]))
    assert tr["x"].tolist()[:3] == [100, 100, 100]     # waits at the start point (also before the first move)
    assert tr["x"][3] == pytest.approx(200)            # half-way at the middle of the window: speed follows the times
    assert tr["x"][4] == 300 and tr["x"][5] == 300     # arrived at t1 and stays
    assert tr["moves"][0]["kind"] == "walk" and tr["moves"][0]["id"] == "a-b-4.0"


def test_track_floor_change_fades():
    tr = compute_track([MV("a", "c", 2.0, 3.0)], ["f1", "f2"], np.array([1.0, 2.2, 2.8, 3.5]), {})
    assert tr["floor"].tolist() == [0, 0, 1, 1] and tr["moves"][0]["kind"] == "fade"   # floors change by fading, no glide
    assert tr["alpha"][1] < 1 and tr["alpha"][3] == 1
    assert tr["x"][0] == 100 and tr["x"][3] == 50


def test_track_empty_incomplete_and_unknown_floors():
    assert compute_track([], ["f1"], np.array([0.0])) is None
    half = [{"id": "m1", "a": {"floor": "f1", "x": 1, "y": 1}, "b": None, "t0": 1.0, "t1": None}]
    assert compute_track(half, ["f1"], np.array([0.0])) is None                     # end point not placed yet
    assert compute_track([MV("a", "c", 1.0, 2.0)], ["f1"], np.array([0.0])) is None  # a point on a floor that is gone
    assert compute_track([MV("a", "b", 5.0, 5.0)], ["f1"], np.array([0.0])) is None  # arrival not after departure


def test_motion_analysis_suggests_stops(sample):
    a = analyze_video(str(sample / "walk.mp4"))
    t, e = np.asarray(a["times"]), np.asarray(a["energy"])
    assert e[(t > 0.5) & (t < 2.5)].mean() > 2 * e[(t > 8.5) & (t < 9.8)].mean()
    assert any(s["reason"] == "정지" for s in a["suggestions"])


def test_chalk_minimap_turns_dark_lines_white(sample):
    plan = auto_trim(load_plan(sample / "plan_1f.png"))
    mm = Minimap([plan], ["1F"], merged_settings({"chalk_texture": False}), "Test mini map", 400, 1000)
    img = mm.bases[0].astype(int)
    ox, oy, sc = mm.fits[0]
    # a wall pixel of the source plan should be light, open floor should stay board-dark
    # middle of the left outer wall
    dark = cv2.cvtColor(plan, cv2.COLOR_BGR2GRAY) < 60
    col = np.where(dark[plan.shape[0] // 2])[0][:15].mean()
    wy, wx = int(oy + plan.shape[0] / 2 * sc), int(ox + col * sc)
    assert img[wy - 2 : wy + 3, wx - 3 : wx + 4].mean(axis=2).max() > 150
    assert img[mm.h // 2, mm.w // 2 - 20].mean() < 130


def test_render_all_outputs(sample, tmp_path):
    floors = [{"id": "f1", "label": "1F", "path": sample / "plan_1f.png"},
              {"id": "f2", "label": "2F", "path": sample / "plan_2f.png"}]
    moves = [MV("a", "b", 2, 4), MV("b", "c", 6, 8)]
    files = render_outputs(sample / "walk.mp4", floors, ROOMS, moves, {}, "Signature house mini map",
                           tmp_path, ["composite", "overlay", "minimap"])
    assert set(files) == {"composite.mp4", "overlay.mov", "minimap_1F.png", "minimap_2F.png", "plan_1F.png", "plan_2F.png"}
    for f in files:
        assert (tmp_path / f).stat().st_size > 1000
    png = cv2.imread(str(tmp_path / "minimap_1F.png"), cv2.IMREAD_UNCHANGED)
    assert png.shape[2] == 4 and png.shape[1] == 1600
    assert "qtrle" in subprocess.run([__import__("app.render", fromlist=["FFMPEG"]).FFMPEG, "-hide_banner", "-i", str(tmp_path / "overlay.mov")], capture_output=True, text=True).stderr


def test_walls_mode_drops_text_dimensions_and_furniture(sample):
    from app.render import structure_alpha
    plan = auto_trim(load_plan(sample / "plan_1f.png"))
    ph, pw = plan.shape[:2]
    full = (0, 0, pw, ph)
    s = merged_settings({"line_mode": "walls"})
    walls = structure_alpha(plan, s, [], full, pw, ph, 4)
    lines = structure_alpha(plan, {**s, "line_mode": "lines"}, [], full, pw, ph, 4)
    # the dimension line under the plan (below the outer wall) survives only in "lines" mode
    below = slice(int(ph * 0.93), ph)
    assert lines[below].max() > 0.5 and walls[below].max() < 0.1
    # the outer walls survive in both
    assert walls[:, : int(pw * 0.03) + 10].max() > 0.5


def test_structure_mode_keeps_dark_walls_only(sample):
    """Rendered plans: coloured floors/furniture must not become lines, dark walls must."""
    from app.render import plan_structure
    plan = auto_trim(load_plan(sample / "plan_1f.png"))
    st = plan_structure(plan, merged_settings({"line_mode": "structure"}))
    k = st["k"]
    # the grey furniture outline (x 480-700, y 130-180 in the source, minus trim) is not a wall
    oy = ox = 93 - 30  # auto_trim keeps a 3% (30px) margin around the drawing that starts at 93
    fur = st["mask"][int((150 - oy) * k), int((480 - ox) * k) : int((700 - ox) * k)]
    assert fur.max() == 0
    assert st["mask"].sum() > 0 and st["bbox"] is not None


def test_edits_draw_door_stairs_and_erase(sample):
    from app.render import plan_structure, structure_alpha
    plan = auto_trim(load_plan(sample / "plan_1f.png"))
    ph, pw = plan.shape[:2]
    s = merged_settings({"line_mode": "structure"})
    full = (0, 0, pw, ph)
    base = structure_alpha(plan, s, [], full, pw, ph, 3)
    stairs = [{"type": "stairs", "a": [500, 300], "b": [560, 450]}]
    with_stairs = structure_alpha(plan, s, stairs, full, pw, ph, 3)
    assert with_stairs[300:450, 500:560].sum() > base[300:450, 500:560].sum() + 50
    # erasing the whole plan leaves nothing automatic
    erase = [{"type": "erase", "pts": [[0, y] for y in range(0, ph, 20)] + [[pw, y] for y in range(ph, 0, -20)], "r": pw}]
    assert plan_structure(plan, s, erase)["mask"].sum() == 0


def test_room_names_are_drawn_on_the_panel(sample):
    plan = auto_trim(load_plan(sample / "plan_1f.png"))
    s = merged_settings({"chalk_texture": False})
    rooms = [[{"name": "거실", "x": 300, "y": 300}]]
    bare = Minimap([plan], ["1F"], s, "t", 400, 1000).bases[0].astype(int)
    named = Minimap([plan], ["1F"], s, "t", 400, 1000, rooms).bases[0].astype(int)
    assert np.abs(bare - named).sum() > 0


def test_transparent_board_keeps_lines_text_and_marker(sample):
    """panel_opacity only fades the board: lines, room names and the marker stay opaque."""
    plan = auto_trim(load_plan(sample / "plan_1f.png"))
    rooms = [[{"name": "Kitchen", "x": 550, "y": 170}]]
    mm = Minimap([plan], ["1F"], merged_settings({"panel_opacity": 0.0}), "t", 420, 1000, rooms)
    img, alpha = mm.draw(0, 550, 170)
    ox, oy, sc = mm.fits[0]
    assert alpha[mm.h // 2, 8] < 0.05                                   # board is see-through
    assert alpha[img.mean(axis=2) > 200].max() > 0.9                    # chalk lines / names are not
    assert alpha[int(oy + 170 * sc), int(ox + 550 * sc)] > 0.95         # marker centre


def test_fixture_shapes_and_thin_lines():
    from app.render import draw_edits
    img = np.zeros((200, 200), np.uint8)
    draw_edits(img, [{"type": "rect", "a": [10, 10], "b": [60, 60]},
                     {"type": "circle", "c": [140, 50], "r": 30},
                     {"type": "toilet", "a": [100, 190], "b": [100, 150]}], 1.0, value=255, thickness=4)
    assert img[10, 35] > 0 and img[35, 35] == 0          # rectangle outline only
    assert img[50, 170] > 0 and img[50, 140] == 0        # circle outline only
    # toilet ("D"): flat side on the wall (half width = depth / 2.6 ~ 15px), straight side, round front tip
    assert img[190, 90] > 0 and img[190, 70] == 0 and img[175, 115] > 0 and img[150, 100] > 0
    thick, thin = np.zeros((50, 100), np.uint8), np.zeros((50, 100), np.uint8)
    draw_edits(thick, [{"type": "line", "pts": [[5, 25], [95, 25]]}], 1.0, value=255, thickness=10)
    draw_edits(thin, [{"type": "line", "pts": [[5, 25], [95, 25]], "thin": True}], 1.0, value=255, thickness=10)
    # compare ink, not pixel counts (anti-aliased edges would blur the difference)
    assert 0 < thin.sum() < 0.6 * thick.sum()


def test_walk_bends_at_the_moves_via_points():
    p0, p1 = {"floor": "f1", "x": 0, "y": 0}, {"floor": "f1", "x": 400, "y": 0}
    planned = plan_moves([MV(p0, p1, 0.0, 10.0, via=[[0, 300], [400, 300]])], ["f1"])
    assert planned[0]["poly"].tolist() == [[0, 0], [0, 300], [400, 300], [400, 0]]   # straight legs through the bends
    tr = compute_track([MV(p0, p1, 0.0, 10.0, via=[[0, 300], [400, 300]])], ["f1"], np.array([5.0]))
    assert tr["y"][0] == 300                                                          # half-way along the bent route


def test_jump_mode_fades_instead_of_walking():
    t = np.array([4.0, 4.5, 4.75, 5.25, 5.5, 6.0, 9.5])
    tr = compute_track([MV("a", "b", 4.5, 5.5, mode="jump"), MV("b", "a", 9.0, 10.0)], ["f1", "f2"], t)
    a = tr["alpha"]
    assert a[0] == 1 and a[1] == pytest.approx(1, abs=1e-6)          # before the fade
    assert a[2] < 0.6 and tr["x"][2] == 100                            # fading out at the start point
    assert a[3] < 0.6 and tr["x"][3] == 300                            # fading in at the end point (no sliding)
    assert a[4] == 1 and a[5] == 1
    assert 100 < tr["x"][6] < 300 and a[6] == 1                        # the next move walks (default)
    assert [m["kind"] for m in tr["moves"]] == ["fade", "walk"]


def test_move_from_elsewhere_fades_over_first():
    # 거실 -> 주방 at 4~6, then a move that starts at 안방's spot on the same floor? no: at a third point on f1
    p = {"floor": "f1", "x": 300, "y": 300}
    planned = plan_moves([MV("a", "b", 4.0, 6.0), MV(p, "a", 10.0, 12.0)], ["f1", "f2"], {"fade_sec": 0.5})
    kinds = [(m["kind"], m.get("hop", False), round(m["start"], 2), round(m["end"], 2)) for m in planned]
    assert kinds == [("walk", False, 4.0, 6.0),
                     ("fade", True, 9.5, 10.0),         # 주방 -> the new start point, just before the move
                     ("walk", False, 10.0, 12.0)]
    assert planned[2]["from"] == p and planned[1]["from"]["x"] == 300 and planned[1]["from"]["y"] == 100


def test_show_windows_choose_the_plan_and_ease_in_and_out():
    moves = [MV("a", "c", 10.0, 11.0)]                                # marker: f1 until ~10s, then f2
    t = np.array([0.0, 1.0, 1.3, 2.0, 5.0, 7.7, 8.0, 8.3, 9.0, 12.0, 14.7, 15.0, 16.0])
    tr = compute_track(moves, ["f1", "f2"], t, {"panel_fade_sec": 0.6}, windows=[(1.0, 8.0), (8.0, 15.0)])
    pf, pa = tr["pfloor"], tr["panel"]
    assert pf[0] == -1 and pa[0] == 0                                  # nothing on screen before any window
    assert pf[1] == 0 and pa[1] == 0 and 0.4 < pa[2] < 0.6 and pa[3] == 1   # 1F eases in from 1.0
    assert 0.4 < pa[5] < 0.6                                           # ...and out before 8.0
    assert pf[6] == 1 and pa[6] == 0 and 0.4 < pa[7] < 0.6             # 2F takes over at 8.0 although the marker is still on 1F
    assert tr["floor"][8] == 0 and pf[8] == 1                          # (marker on 1F, plan 2F -> marker hidden by the renderer)
    assert pf[9] == 1 and pa[9] == 1 and 0.4 < pa[10] < 0.6            # 2F eases out before 15.0
    assert pf[11] == -1 and pa[11] == 0 and pa[12] == 0                # nothing after the last window


def test_floor_without_window_follows_the_marker():
    t = np.array([0.0, 5.0, 9.0, 12.0, 20.0, 30.0])
    tr = compute_track([MV("a", "c", 10.0, 11.0)], ["f1", "f2"], t, {"panel_fade_sec": 0.6}, windows=[(None, None), (10.0, 25.0)])
    assert tr["pfloor"].tolist() == [0, 0, 0, 1, 1, -1]                # auto 1F, then 2F's window, then nothing
    assert tr["panel"][0] == 1                                         # no fade-in at the very start of the video


# ---------- automatic vectorisation (app/vectorize.py) ----------

def test_auto_edits_vectorise_walls_doors_and_windows(sample):
    from app.vectorize import auto_edits
    plan = auto_trim(load_plan(sample / "plan_1f.png"))
    edits = auto_edits(plan, merged_settings({"line_mode": "structure"}))
    assert edits and all(e.get("auto") for e in edits)
    walls = [e for e in edits if e["type"] == "line" and not e.get("thin")]
    assert len(walls) >= 8
    for e in walls:   # straight, axis-aligned lines: no bumpy tracing
        (x0, y0), (x1, y1) = e["pts"]
        assert x0 == x1 or y0 == y1
    # outer walls of the source sit at x=100/900, y=100/700; auto_trim cuts 63px off each side
    xs = sorted({e["pts"][0][0] for e in walls if e["pts"][0][0] == e["pts"][1][0]})
    ys = sorted({e["pts"][0][1] for e in walls if e["pts"][0][1] == e["pts"][1][1]})
    assert abs(xs[0] - 37) < 6 and abs(xs[-1] - 837) < 6 and abs(ys[0] - 37) < 6 and abs(ys[-1] - 637) < 6
    doors = sorted((e for e in edits if e["type"] == "door"), key=lambda d: d["hinge"][0])
    assert len(doors) == 2
    assert doors[0]["hinge"] == pytest.approx([267, 337], abs=5)   # arc centre (330, 400) in the source
    assert doors[1]["hinge"] == pytest.approx([387, 267], abs=5)   # arc centre (450, 330)
    for d in doors:   # radius 90 in the source, the leaf is perpendicular to its wall
        assert abs(math.hypot(d["end"][0] - d["hinge"][0], d["end"][1] - d["hinge"][1]) - 90) < 12
        assert d["end"][0] == d["hinge"][0] or d["end"][1] == d["hinge"][1]
    windows = [e for e in edits if e["type"] == "line" and e.get("thin")]
    assert any(abs(e["pts"][0][1] - 37) < 8 and e["pts"][0][0] > 500 for e in windows)   # window in the top wall (600-800)


def test_auto_edits_find_a_flight_of_stairs():
    from app.vectorize import auto_edits
    img = np.full((600, 800, 3), 255, np.uint8)
    cv2.rectangle(img, (50, 50), (750, 550), (20, 20, 20), 14)
    for i in range(8):   # 8 step lines, 25px apart, white treads between them
        cv2.line(img, (600, 200 + i * 25), (680, 200 + i * 25), (80, 80, 80), 2)
    cv2.line(img, (600, 200), (600, 375), (80, 80, 80), 2)
    cv2.line(img, (680, 200), (680, 375), (80, 80, 80), 2)
    edits = auto_edits(img, merged_settings({"line_mode": "structure"}))
    st = [e for e in edits if e["type"] == "stairs"]
    assert len(st) == 1
    (ax, ay), (bx, by) = st[0]["a"], st[0]["b"]
    assert abs(min(ax, bx) - 600) < 10 and abs(max(ax, bx) - 680) < 10
    assert abs(min(ay, by) - 187) < 15 and abs(max(ay, by) - 388) < 15
    assert st[0]["steps"] == 9 and st[0]["flip"] is False
    assert len([e for e in edits if e["type"] == "line" and not e.get("thin")]) == 4   # just the frame


def test_auto_lines_replace_the_raster_and_the_eraser_clips_them(sample):
    from app.render import structure_alpha
    plan = auto_trim(load_plan(sample / "plan_1f.png"))
    ph, pw = plan.shape[:2]
    s = merged_settings({"line_mode": "structure"})
    full = (0, 0, pw, ph)
    raster = structure_alpha(plan, s, [], full, pw, ph, 3)
    auto = [{"type": "line", "pts": [[37, 37], [837, 37]], "auto": True}]
    a = structure_alpha(plan, s, auto, full, pw, ph, 3)
    assert raster[300:340, 30:45].max() > 0.5      # the left outer wall, from the raster
    assert a[300:340, 30:45].max() < 0.05          # gone: automatic vectors stand in for the raster
    assert a[33:41, 400].max() > 0.5               # the automatic line itself
    erased = structure_alpha(plan, s, auto + [{"type": "erase", "pts": [[400, 37]], "r": 20}], full, pw, ph, 3)
    assert erased[33:41, 400].max() < 0.05 and erased[33:41, 100].max() > 0.5
    # edits are layered: the eraser wipes what was drawn before it, later items stay whole
    hand = structure_alpha(plan, s, auto + [{"type": "line", "pts": [[100, 300], [700, 300]]},
                                            {"type": "erase", "pts": [[400, 300]], "r": 20},
                                            {"type": "line", "pts": [[100, 500], [700, 500]]},
                                            {"type": "erase", "pts": [[400, 500]], "r": 20},
                                            {"type": "line", "pts": [[400, 480], [400, 520]]}], full, pw, ph, 3)
    assert hand[296:304, 400].max() < 0.05 and hand[296:304, 200].max() > 0.5
    assert hand[496:504, 388].max() < 0.05 and hand[485:490, 400].max() > 0.5   # drawn after the stroke: intact


def test_fixture_symbols_draw_inside_their_box():
    from app.render import draw_edits
    for t in ("basin", "sink", "induction", "closet"):
        img = np.zeros((200, 300), np.uint8)
        draw_edits(img, [{"type": t, "a": [20, 20], "b": [280, 120]}], 1.0, value=255, thickness=3)
        assert img[20, 150] > 0 and img[120, 150] > 0 and img[70, 20] > 0, t   # the box outline
        assert img[30:110, 30:270].max() > 0, t                                  # the symbol inside
        assert img[130:, :].max() == 0 and img[:, 290:].max() == 0, t           # nothing outside


def test_clean_edits_keeps_auto_flag_and_fixtures():
    from app.main import clean_edits
    out = clean_edits([{"type": "basin", "a": [1, 2], "b": [3, 4], "thin": True, "auto": True},
                       {"type": "stairs", "a": [0, 0], "b": [10, 30], "steps": 5, "flip": True},
                       {"type": "bogus", "a": [0, 0]}])
    assert out == [{"type": "basin", "a": [1.0, 2.0], "b": [3.0, 4.0], "thin": True, "auto": True},
                   {"type": "stairs", "a": [0.0, 0.0], "b": [10.0, 30.0], "flip": True, "steps": 5}]


def test_upload_runs_auto_detection_and_redetect_api(sample):
    from fastapi.testclient import TestClient
    from app import main
    assert str(main.DATA_ROOT).startswith(tempfile.gettempdir())   # never the real data/ folder
    client = TestClient(main.app)
    with open(sample / "walk.mp4", "rb") as v, open(sample / "plan_1f.png", "rb") as p:
        r = client.post("/api/projects", files=[("video", ("walk.mp4", v, "video/mp4")), ("plans", ("plan_1f.png", p, "image/png"))],
                        data={"name": "t"})
    assert r.status_code == 200, r.text
    proj = r.json()
    pid, fl = proj["id"], proj["floors"][0]
    assert any(e.get("auto") and e["type"] == "door" for e in fl["edits"])
    assert any(e.get("auto") and e["type"] == "line" for e in fl["edits"])
    # clearing removes the automatic items only
    client.put(f"/api/projects/{pid}", json={"floors": [{"id": fl["id"], "edits": fl["edits"] + [{"type": "rect", "a": [1, 1], "b": [5, 5]}]}]})
    r = client.post(f"/api/projects/{pid}/floors/{fl['id']}/auto", json={"kinds": []})
    assert r.json()["floors"][0]["edits"] == [{"type": "rect", "a": [1.0, 1.0], "b": [5.0, 5.0]}]
    r = client.post(f"/api/projects/{pid}/floors/{fl['id']}/auto", json={"kinds": ["doors"]})
    edits = r.json()["floors"][0]["edits"]
    assert {e["type"] for e in edits if e.get("auto")} == {"door"} and edits[-1] == {"type": "rect", "a": [1.0, 1.0], "b": [5.0, 5.0]}
    client.delete(f"/api/projects/{pid}")
