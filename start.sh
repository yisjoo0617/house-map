#!/usr/bin/env bash
# House-Map launcher for macOS / Linux: installs dependencies on first run, then starts the app.
set -e
cd "$(dirname "$0")"

if [ ! -x .venv/bin/python ]; then
  echo "House-Map 첫 실행: 필요한 프로그램을 설치합니다 (몇 분 걸립니다)."
  PY=$(command -v python3 || command -v python || true)
  if [ -z "$PY" ]; then
    echo "Python 3.12 이상을 설치한 뒤 다시 실행하세요: https://www.python.org/downloads/"
    exit 1
  fi
  "$PY" -m venv .venv
  .venv/bin/python -m pip install --upgrade pip
  .venv/bin/python -m pip install -r requirements.txt || { rm -rf .venv; echo "설치 실패"; exit 1; }
fi

exec .venv/bin/python run.py "$@"
