#!/usr/bin/env bash
# ============================================================
#  관제판 작업 드라이버 (macOS / Linux / Git Bash)
#  실제 처리는 작업/작업드라이버.py 가 한다. 이 파일은 파이썬을 찾아 넘기는 껍데기다.
#  실행: bash 작업드라이버.sh [프로젝트] [once|watch]
# ============================================================
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PY=""
command -v python3 >/dev/null 2>&1 && PY=python3
[ -z "$PY" ] && command -v python >/dev/null 2>&1 && PY=python

if [ -z "$PY" ]; then
  echo ""
  echo "  ✗ 파이썬이 없습니다."
  echo "    → 파이썬 3.7 이상을 설치한 뒤 다시 실행하세요."
  exit 1
fi

"$PY" "$HERE/작업드라이버.py" "$@"
