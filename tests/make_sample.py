"""Generate a synthetic walkthrough video + a 2-floor house plan for testing.

The 'camera' looks at a large random texture: zooming in = walking forward,
horizontal shift = turning. Timeline: walk 0-3s, stand & pan right 3-5s, walk 5-8s, stand 8-10s.
"""
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

out = Path(sys.argv[1] if len(sys.argv) > 1 else "tests/sample")
out.mkdir(parents=True, exist_ok=True)
rng = np.random.default_rng(0)
W, H, FPS, DUR = 640, 360, 30, 10.0

tex = rng.integers(0, 255, (1200, 3000, 3), np.uint8)
tex = cv2.GaussianBlur(cv2.resize(cv2.resize(tex, (300, 120)), (3000, 1200), interpolation=cv2.INTER_NEAREST), (5, 5), 0)
for _ in range(400):
    c = tuple(int(v) for v in rng.integers(0, 255, 3))
    cv2.circle(tex, (int(rng.integers(0, 3000)), int(rng.integers(0, 1200))), int(rng.integers(5, 30)), c, -1)

vw = cv2.VideoWriter(str(out / "walk.mp4"), cv2.VideoWriter_fourcc(*"mp4v"), FPS, (W, H))
cx, zoom = 1500.0, 1.0
for i in range(int(DUR * FPS)):
    t = i / FPS
    if t < 3 or 5 <= t < 8:
        zoom *= 1.004
    if 3 <= t < 5:
        cx += 6  # pan right
    if zoom > 1.6:
        zoom = 1.0
    cw, ch = 1600 / zoom, 900 / zoom
    x0, y0 = int(cx - cw / 2), int(600 - ch / 2)
    vw.write(cv2.resize(tex[y0 : y0 + int(ch), x0 : x0 + int(cw)], (W, H)))
vw.release()

FONT = str(Path(__file__).resolve().parent.parent / "static" / "fonts" / "NanumGothic-Bold.ttf")


def plan_image(walls, labels, path, floors=(), doors=(), furniture=()):
    """Imitates a sales floor plan: coloured floors, thick walls, door arcs, windows, dimensions, text."""
    img = Image.new("RGB", (1000, 800), "white")
    d = ImageDraw.Draw(img)
    for box, col in floors:
        d.rectangle(box, fill=col)
    for box in furniture:
        d.rectangle(box, outline=(150, 150, 150), width=2)
    for x0, y0, x1, y1 in walls:
        d.rectangle((min(x0, x1) - 7, min(y0, y1) - 7, max(x0, x1) + 7, max(y0, y1) + 7), fill=(20, 20, 20))
    d.rectangle((600, 93, 800, 107), fill="white", outline=(20, 20, 20), width=2)   # window
    d.line((600, 100, 800, 100), fill=(20, 20, 20), width=1)
    for cx, cy, r, start in doors:
        d.arc((cx - r, cy - r, cx + r, cy + r), start, start + 90, fill=(60, 60, 60), width=2)
    f = ImageFont.truetype(FONT, 26)
    small = ImageFont.truetype(FONT, 14)
    for (x, y), t in labels:
        d.text((x, y), t, font=f, fill=(40, 40, 40), anchor="mm")
    d.line((100, 750, 900, 750), fill=(90, 90, 90), width=1)                         # dimension line
    for x in (100, 450, 900):
        d.line((x, 742, x, 758), fill=(90, 90, 90), width=1)
    d.text((275, 738), "3,500", font=small, fill=(90, 90, 90), anchor="mm")
    d.text((675, 738), "4,500", font=small, fill=(90, 90, 90), anchor="mm")
    img.save(path)


plan_image(
    [(100, 100, 900, 100), (900, 100, 900, 700), (900, 700, 100, 700), (100, 700, 100, 100),
     (450, 100, 450, 330), (450, 430, 450, 700), (100, 400, 330, 400), (600, 450, 900, 450), (600, 450, 600, 520)],
    [((270, 250), "욕실"), ((270, 550), "침실"), ((680, 270), "주방"), ((750, 600), "거실")],
    out / "plan_1f.png",
    floors=[((600, 450, 900, 700), (226, 200, 160)), ((100, 100, 450, 400), (200, 225, 235))],
    doors=[(450, 330, 90, 0), (330, 400, 90, 180)],
    furniture=[(480, 130, 700, 180), (620, 560, 760, 640)],
)
plan_image(
    [(100, 100, 900, 100), (900, 100, 900, 600), (900, 600, 100, 600), (100, 600, 100, 100), (500, 100, 500, 280), (500, 380, 500, 600)],
    [((300, 350), "안방"), ((700, 350), "드레스룸")],
    out / "plan_2f.png",
    doors=[(500, 280, 90, 0)],
    furniture=[(150, 150, 350, 300)],
)
print("wrote", out)
