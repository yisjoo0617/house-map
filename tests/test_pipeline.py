import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.motion import analyze_video  # noqa: E402
from app.render import Minimap, auto_trim, load_plan, merged_settings, render_outputs  # noqa: E402
from app.track import compute_room_track  # noqa: E402

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


def test_room_track_rests_and_glides():
    events = [{"t": 0, "room": "a"}, {"t": 5, "room": "b"}]
    tr = compute_room_track(ROOMS, events, ["f1", "f2"], np.array([0, 4.5, 5.0, 5.5, 9]),
                            {"move_timing": "time", "transition_sec": 1.0})
    assert tr["x"].tolist()[:2] == [100, 100]          # resting in 거실
    assert tr["x"][2] == pytest.approx(200)            # half-way at the recorded moment
    assert tr["x"][3] == 300 and tr["x"][4] == 300     # arrived in 주방


def test_room_track_jump_and_floor_change():
    events = [{"t": 1, "room": "a"}, {"t": 3, "room": "c"}]
    tr = compute_room_track(ROOMS, events, ["f1", "f2"], np.array([0, 2.6, 3.4, 4]),
                            {"move_timing": "time", "transition_sec": 1.0, "fade_sec": 0.6})
    assert tr["floor"].tolist() == [0, 0, 1, 1]        # stairs: switch during the fade, no glide across floors
    assert tr["x"][0] == 100                           # before the first record: starting room
    assert tr["x"][2] == 50


def test_room_track_empty_and_unknown_rooms():
    assert compute_room_track(ROOMS, [], ["f1"], np.array([0.0])) is None
    assert compute_room_track(ROOMS, [{"t": 0, "room": "zzz"}], ["f1"], np.array([0.0])) is None


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
    events = [{"t": 0, "room": "a"}, {"t": 4, "room": "b"}, {"t": 8, "room": "c"}]
    files = render_outputs(sample / "walk.mp4", floors, ROOMS, events, {}, "Signature house mini map",
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
    assert img[190, 80] > 0 and img[150, 100] > 0        # toilet: flat side on the wall + bowl tip
    thick, thin = np.zeros((50, 100), np.uint8), np.zeros((50, 100), np.uint8)
    draw_edits(thick, [{"type": "line", "pts": [[5, 25], [95, 25]]}], 1.0, value=255, thickness=10)
    draw_edits(thin, [{"type": "line", "pts": [[5, 25], [95, 25]], "thin": True}], 1.0, value=255, thickness=10)
    # compare ink, not pixel counts (anti-aliased edges would blur the difference)
    assert 0 < thin.sum() < 0.6 * thick.sum()


def _wall_with_door():
    """800x400 white plan, outer walls, and a middle wall whose only opening is near the bottom."""
    plan = np.full((400, 800, 3), 255, np.uint8)
    cv2.rectangle(plan, (20, 20), (780, 380), (20, 20, 20), 12)
    cv2.line(plan, (400, 20), (400, 300), (20, 20, 20), 12)   # door gap from y=300 to 380
    return plan


def test_route_goes_through_the_doorway_not_the_wall():
    from app.path import route
    plan = _wall_with_door()
    s = merged_settings({"line_mode": "walls"})
    pts = np.array(route(plan, s, [], (200, 100), (600, 100)))
    assert pts[0].tolist() == [200, 100] and pts[-1].tolist() == [600, 100]
    crossing = pts[np.argmin(np.abs(pts[:, 0] - 400))]
    assert crossing[1] > 300                                  # passes the wall line inside the door gap
    length = np.linalg.norm(np.diff(pts, axis=0), axis=1).sum()
    assert length > 550                                       # a detour (~620px), not the 400px straight line


def test_drawn_line_closes_an_opening():
    from app.path import route
    plan = _wall_with_door()
    s = merged_settings({"line_mode": "walls"})
    shut = [{"type": "line", "pts": [[400, 300], [400, 380]]}]
    open_len = np.linalg.norm(np.diff(np.array(route(plan, s, [], (200, 100), (600, 100))), axis=0), axis=1).sum()
    # with the doorway closed the only way is through a wall: the route falls back to crossing it
    pts = np.array(route(plan, s, shut, (200, 100), (600, 100)))
    assert np.linalg.norm(np.diff(pts, axis=0), axis=1).sum() < open_len


def test_speed_mode_scales_duration_with_route_length():
    from app.track import plan_moves
    rooms = [{"id": "a", "floor": "f1", "x": 0, "y": 0}, {"id": "b", "floor": "f1", "x": 100, "y": 0},
             {"id": "c", "floor": "f1", "x": 500, "y": 0}]
    events = [{"t": 0, "room": "a"}, {"t": 10, "room": "b"}, {"t": 20, "room": "c"}]
    s = {"move_timing": "speed", "cross_sec": 10.0, "move_anchor": "start", "follow_path": False}
    moves, _, _ = plan_moves(rooms, events, ["f1"], s, None, {"f1": 1000.0})
    d1, d2 = (m["end"] - m["start"] for m in moves)
    assert d1 == pytest.approx(1.0) and d2 == pytest.approx(4.0)   # 100px and 400px at 100px/s
    assert moves[0]["start"] == 10 and moves[1]["start"] == 20      # anchor = start of the move


def test_jump_fades_out_and_in_and_modes_can_be_set_per_move():
    events = [{"t": 0, "room": "a"}, {"t": 5, "room": "b", "mode": "jump"}, {"t": 9, "room": "a"}]
    s = {"transition": "slide", "move_timing": "time", "transition_sec": 1.0, "fade_sec": 1.0, "follow_path": False}
    t = np.array([4.0, 4.5, 4.75, 5.25, 5.5, 6.0, 9.0])
    tr = compute_room_track(ROOMS, events, ["f1", "f2"], t, s)
    a = tr["alpha"]
    assert a[0] == 1 and a[1] == pytest.approx(1, abs=1e-6)          # before the fade
    assert a[2] < 0.6 and tr["x"][2] == 100                            # fading out in the old room
    assert a[3] < 0.6 and tr["x"][3] == 300                            # fading in at the new room (no sliding)
    assert a[4] == 1 and a[5] == 1
    assert 100 < tr["x"][6] < 300 and a[6] == 1                         # the next move walks (default)
    kinds = [m["kind"] for m in tr["moves"]]
    assert kinds == ["fade", "walk"]


def test_floor_change_fades():
    events = [{"t": 0, "room": "a"}, {"t": 5, "room": "c"}]
    tr = compute_room_track(ROOMS, events, ["f1", "f2"], np.array([4.8, 5.0, 5.2]), {"fade_sec": 1.0})
    assert tr["floor"].tolist() == [0, 1, 1] and tr["alpha"][0] < 1 and tr["alpha"][2] < 1
