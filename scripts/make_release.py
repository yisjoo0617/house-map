"""Build a zip to hand to another PC: `python scripts/make_release.py` -> dist/house-map-YYYYMMDD.zip

Includes the app and your saved style presets (so both PCs produce identical minimaps),
but no virtualenv, projects, videos or test data.
"""
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INCLUDE = ["app", "static", "docs", "requirements.txt", "run.py", "start.bat", "start.sh", "README.md", "설치방법.txt"]
OPTIONAL = ["data/presets.json"]


def main() -> None:
    out = ROOT / "dist" / f"house-map-{time.strftime('%Y%m%d')}.zip"
    out.parent.mkdir(exist_ok=True)
    files: list[Path] = []
    for name in INCLUDE:
        p = ROOT / name
        files += [f for f in p.rglob("*") if f.is_file()] if p.is_dir() else [p]
    files += [ROOT / n for n in OPTIONAL if (ROOT / n).exists()]
    files = [f for f in files if "__pycache__" not in f.parts]

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for f in files:
            arc = Path("house-map") / f.relative_to(ROOT)
            info = zipfile.ZipInfo.from_file(f, arc)
            if f.name == "start.sh":
                info.external_attr = 0o755 << 16
            with f.open("rb") as fh:
                z.writestr(info, fh.read(), zipfile.ZIP_DEFLATED)
    presets = "포함" if (ROOT / OPTIONAL[0]).exists() else "없음"
    print(f"{out}  ({out.stat().st_size / 1e6:.1f}MB, 파일 {len(files)}개, 스타일 프리셋 {presets})")


if __name__ == "__main__":
    main()
