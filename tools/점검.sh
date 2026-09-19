#!/usr/bin/env bash
# ============================================================
#  관제판 설치 점검 (macOS / Linux / Git Bash)
#  실행: bash 점검.sh
#  무엇이 준비됐고 무엇이 비었는지 ✓/✗ 로 알려준다. 아무것도 바꾸지 않는다.
# ============================================================
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OK=1

echo ""
echo "── 관제판 설치 점검 ──"

echo ""
echo "[1] 파이썬 (작업보드 명령줄 클라이언트용)"
if command -v python3 >/dev/null 2>&1; then
  echo "  ✓ 있음 — $(python3 --version 2>&1)"
  PY=python3
else
  echo "  ✗ 없음 → 파이썬 3.7 이상을 설치하세요"
  OK=0; PY=""
fi

echo ""
echo "[2] AI CLI (자동토론용 — 최소 둘 필요)"
FOUND=0
check_cli () {  # $1=명령 $2=표시이름
  if command -v "$1" >/dev/null 2>&1; then
    echo "  ✓ $2 ($1) 있음"; FOUND=$((FOUND+1))
  else
    echo "  ↷ $2 ($1) 없음 — 이 참가자는 토론에서 자동으로 빠집니다"
  fi
}
check_cli claude 클로드코드
check_cli codex  코덱스
check_cli hermes 헤르메스
[ "$FOUND" -lt 2 ] && echo "  ↷ 쓸 수 있는 CLI가 ${FOUND}개입니다. 자동토론에는 둘 이상을 권합니다(작업보드만 쓰는 건 지장 없음)."

echo ""
echo "[3] 설정 파일"
CLIENT_CFG="$ROOT/client/gwanje.config.json"
DISCUSS_CFG="$ROOT/discuss/자동토론.config.json"

check_cfg () {  # $1=경로 $2=표시 $3=url경로(python) $4=token경로(python)
  if [ -f "$1" ]; then
    if [ -n "$PY" ] && $PY -c "
import json,sys
d=json.load(open(sys.argv[1],encoding='utf-8'))
u=$3; t=$4
sys.exit(0 if (u and t) else 1)
" "$1" 2>/dev/null; then
      echo "  ✓ $2 — url·token 채워짐"
    else
      echo "  ✗ $2 — url 또는 token 이 비었거나 JSON 형식 오류"; OK=0
    fi
  else
    echo "  ↷ $2 없음 → 같은 폴더의 *.example.json 을 복사해 만드세요"
  fi
}
check_cfg "$CLIENT_CFG"  "client/gwanje.config.json"      "d.get('url','')"            "d.get('token','')"
check_cfg "$DISCUSS_CFG" "discuss/자동토론.config.json"   "d.get('관제판',{}).get('url','')" "d.get('관제판',{}).get('token','')"

echo ""
echo "[4] 관제판 연결"
if [ -n "$PY" ] && [ -f "$CLIENT_CFG" ]; then
  ( cd "$ROOT/client" && $PY gwanje_client.py doctor )
else
  echo "  ↷ 파이썬 또는 client/gwanje.config.json 이 준비되면 여기서 연결까지 확인합니다"
fi

echo ""
if [ "$OK" -eq 1 ]; then echo "점검 끝."; else echo "점검 끝 — 위의 ✗ 항목을 먼저 해결하세요."; fi
