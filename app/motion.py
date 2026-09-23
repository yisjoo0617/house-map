"""Optical-flow motion analysis of a walkthrough video.

For each pair of sampled frames we estimate:
  - yaw   : camera rotation around the vertical axis (deg, clockwise +), from the
            global horizontal shift of tracked features.
  - energy: translation proxy. After removing the global similarity transform
            (pan/tilt/roll/zoom), walking forward leaves a radial residual flow;
            standing still while panning leaves almost none.
It also suggests keyframe times (stops after walking, sudden scene changes).
"""
from __future__ import annotations

import math
from typing import Callable

import cv2
import numpy as np

ANALYSIS_WIDTH = 320
SAMPLE_FPS = 6.0


def _focal_px(width: int, hfov_deg: float) -> float:
    return (width / 2) / math.tan(math.radians(hfov_deg) / 2)


def _smooth(a: np.ndarray, win: int) -> np.ndarray:
    if len(a) < 3 or win <= 1:
        return a.copy()
    win = min(win, len(a))
    k = np.hanning(win + 2)[1:-1]
    k /= k.sum()
    return np.convolve(np.pad(a, win, mode="edge"), k, mode="same")[win:-win]


def analyze_video(
    path: str,
    hfov_deg: float = 70.0,
    progress: Callable[[float], None] | None = None,
) -> dict:
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise RuntimeError("영상을 열 수 없습니다")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 1
    step = max(1, round(fps / SAMPLE_FPS))

    times: list[float] = []
    yaw_deltas: list[float] = []
    energies: list[float] = []
    hist_diffs: list[float] = []

    prev_gray = prev_hist = None
    focal = None
    idx = 0
    while True:
        ok = cap.grab()
        if not ok:
            break
        if idx % step:
            idx += 1
            continue
        ok, frame = cap.retrieve()
        if not ok:
            break
        t = idx / fps
        h, w = frame.shape[:2]
        scale = ANALYSIS_WIDTH / w
        small = cv2.resize(frame, (ANALYSIS_WIDTH, max(1, round(h * scale))), interpolation=cv2.INTER_AREA)
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
        hist = cv2.calcHist([hsv], [0, 1], None, [16, 16], [0, 180, 0, 256])
        cv2.normalize(hist, hist)
        if focal is None:
            focal = _focal_px(ANALYSIS_WIDTH, hfov_deg)

        dyaw, energy, hdiff = 0.0, 0.0, 0.0
        if prev_gray is not None:
            dyaw, energy = _pair_motion(prev_gray, gray, focal)
            hdiff = float(cv2.compareHist(prev_hist, hist, cv2.HISTCMP_BHATTACHARYYA))
        times.append(t)
        yaw_deltas.append(dyaw)
        energies.append(energy)
        hist_diffs.append(hdiff)
        prev_gray, prev_hist = gray, hist

        if progress and len(times) % 10 == 0:
            progress(min(0.99, idx / total))
        idx += 1
    cap.release()

    if not times:
        raise RuntimeError("영상에서 프레임을 읽지 못했습니다")

    energy = _smooth(np.asarray(energies), 5)
    # normalise so that a typical walking pace is ~1.0
    moving = energy[energy > np.percentile(energy, 40)] if len(energy) > 5 else energy
    ref = float(np.median(moving)) if len(moving) and np.median(moving) > 1e-6 else 1.0
    energy = np.clip(energy / ref, 0, 4)
    yaw = np.cumsum(np.asarray(yaw_deltas))

    return {
        "sample_fps": fps / step,
        "hfov": hfov_deg,
        "times": [round(x, 4) for x in times],
        "energy": [round(float(x), 4) for x in energy],
        "yaw": [round(float(x), 3) for x in yaw],
        "suggestions": suggest_keyframes(np.asarray(times), energy, np.asarray(hist_diffs)),
    }


def _pair_motion(prev: np.ndarray, cur: np.ndarray, focal: float) -> tuple[float, float]:
    pts = cv2.goodFeaturesToTrack(prev, maxCorners=300, qualityLevel=0.01, minDistance=7)
    if pts is None or len(pts) < 12:
        return 0.0, 0.0
    nxt, st, _ = cv2.calcOpticalFlowPyrLK(prev, cur, pts, None, winSize=(21, 21), maxLevel=3)
    good = st.reshape(-1) == 1
    p0, p1 = pts.reshape(-1, 2)[good], nxt.reshape(-1, 2)[good]
    if len(p0) < 12:
        return 0.0, 0.0
    m, inliers = cv2.estimateAffinePartial2D(p0, p1, method=cv2.RANSAC, ransacReprojThreshold=2.0)
    if m is None:
        return 0.0, 0.0
    h, w = prev.shape
    cx, cy = w / 2, h / 2
    # global horizontal shift of the image centre -> yaw. Scene moving left = turning right.
    center_after = m @ np.array([cx, cy, 1.0])
    dx = center_after[0] - cx
    dyaw = math.degrees(math.atan2(-dx, focal))

    # residual flow after removing the similarity transform: parallax from translation
    pred = (m[:, :2] @ p0.T).T + m[:, 2]
    resid = np.linalg.norm(p1 - pred, axis=1)
    # scale change (zoom-like expansion) also indicates forward/backward motion
    s = math.hypot(m[0, 0], m[1, 0])
    energy = float(np.median(resid)) + abs(math.log(max(s, 1e-6))) * w * 0.5
    return dyaw, energy


def suggest_keyframes(times: np.ndarray, energy: np.ndarray, hist_diff: np.ndarray) -> list[dict]:
    """Suggest times worth pinning: start, stops after walking, scene cuts, end."""
    out = [{"t": float(times[0]), "reason": "출발"}]
    if len(times) < 4:
        return out
    moving = energy > 0.35
    min_gap = 2.0
    for i in range(1, len(times)):
        if moving[i - 1] and not moving[i]:
            # require it to have walked for at least ~1s before stopping
            j = i - 1
            while j > 0 and moving[j - 1]:
                j -= 1
            if times[i - 1] - times[j] >= 1.0:
                out.append({"t": float(times[i]), "reason": "정지"})
        if hist_diff[i] > 0.45:
            out.append({"t": float(times[i]), "reason": "장면 전환"})
    out.append({"t": float(times[-1]), "reason": "종료"})

    out.sort(key=lambda s: s["t"])
    dedup: list[dict] = []
    for s in out:
        if dedup and s["t"] - dedup[-1]["t"] < min_gap and s["reason"] != "종료":
            continue
        s["t"] = round(s["t"], 2)
        dedup.append(s)
    return dedup
