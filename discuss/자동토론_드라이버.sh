#!/usr/bin/env bash
# ============================================================
#  관제판 자동토론 드라이버 (공용판, macOS / Linux / Git Bash)
#
#  참가자(클로드·코덱스·헤르메스 등)를 한 명씩 불러 관제판 토론 탭에
#  한 마디씩 올리게 하고, [합의] 가 나오면 멈춘다.
#
#  실행:
#     bash 자동토론_드라이버.sh
#     bash 자동토론_드라이버.sh "주제" 10
#
#  설정은 전부 같은 폴더의 자동토론.config.json 에서 읽는다.
#  (자동토론.config.example.json 을 복사해 값을 채울 것)
#  설정 읽기에 python3 을 쓴다 — 관제판 클라이언트와 같은 전제라 추가 설치는 없다.
#
#  ⚠ 모델 API 키를 쓰지 않는다. 각 CLI가 자기 구독으로 로그인돼 있어야 한다.
# ============================================================
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CFG="$HERE/자동토론.config.json"

if [ ! -f "$CFG" ]; then
  echo "✗ 설정 파일이 없습니다: $CFG"
  echo "  → 같은 폴더의 '자동토론.config.example.json' 을 '자동토론.config.json' 으로 복사한 뒤"
  echo "    관제판 url·token 을 채우고 다시 실행하세요. (docs/2_자동토론_붙이기.md 참고)"
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "✗ python3 을 찾을 수 없습니다. 설정 파일을 읽으려면 파이썬 3.7 이상이 필요합니다."
  exit 1
fi

# ---- 설정을 셸 변수로 펼치기 ----
eval "$(python3 - "$CFG" <<'PY'
import json, sys, shlex
d = json.load(open(sys.argv[1], encoding='utf-8'))
g = d.get('관제판', {}) or {}
t = d.get('토론', {}) or {}
def out(k, v): print("%s=%s" % (k, shlex.quote(str(v))))
out('URL',     g.get('url', ''))
out('TOKEN',   g.get('token', ''))
out('PROJECT', g.get('project', '관제판') or '관제판')
out('CFG_TOPIC',  t.get('주제', ''))
out('CFG_ROUNDS', t.get('라운드', 8) or 8)
out('NOAGREE',    t.get('합의금지_라운드', 0) or 0)
out('RULES',      t.get('발언규칙', ''))
out('REFS',       "\n".join(t.get('참고파일', []) or []))
parts = [p for p in (d.get('참가자') or []) if p.get('사용', True) and p.get('cli')]
out('NPART', len(parts))
for i, p in enumerate(parts):
    out('P%d_NAME'  % i, p.get('이름', ''))
    out('P%d_CLI'   % i, p.get('cli', ''))
    out('P%d_MODEL' % i, p.get('모델', '') or '')
    out('P%d_EFFORT'% i, p.get('추론강도', '') or '')
    out('P%d_ANGLE' % i, p.get('관점', '') or '')
    out('P%d_EXTRA' % i, " ".join(p.get('실행인자', []) or []))
PY
)"

if [ -z "$URL" ] || [ -z "$TOKEN" ]; then
  echo "✗ 설정에 url 또는 token 이 비어 있습니다: $CFG"
  echo "  → url 은 배포한 웹앱 주소(…/exec), token 은 구글시트 '설정' 탭의 24자리 값입니다."
  exit 1
fi

TOPIC="${1:-$CFG_TOPIC}"
ROUNDS="${2:-$CFG_ROUNDS}"
[ -z "$TOPIC" ] && { echo "✗ 주제가 비어 있습니다. 설정의 토론.주제 를 채우거나 실행 인자로 주세요."; exit 1; }

urlenc () { python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$1"; }
E_PROJECT="$(urlenc "$PROJECT")"
E_TOPIC="$(urlenc "$TOPIC")"

# ---- 참가자 추리기: CLI 설치 확인 ----
IDX=()
NAMES=""
for ((i=0; i<NPART; i++)); do
  cli_var="P${i}_CLI";  cli="${!cli_var}"
  nm_var="P${i}_NAME";  nm="${!nm_var}"
  if command -v "$cli" >/dev/null 2>&1; then
    IDX+=("$i"); NAMES="${NAMES:+$NAMES, }$nm"
  else
    echo "↷ '$nm' 은(는) 건너뜁니다 — 명령 '$cli' 을 찾을 수 없습니다(미설치 또는 PATH 미등록)."
  fi
done

if [ "${#IDX[@]}" -lt 1 ]; then
  echo "✗ 실행 가능한 참가자가 하나도 없습니다."
  echo "  → claude / codex 같은 CLI를 설치하고 로그인한 뒤, 설정의 참가자 cli 이름과 맞는지 확인하세요."
  echo "  → 점검: bash ../tools/점검.sh"
  exit 1
fi
[ "${#IDX[@]}" -lt 2 ] && echo "⚠ 참가자가 ${#IDX[@]}명뿐입니다. 토론이 되려면 둘 이상을 권합니다."

PROMPT_FILE="${TMPDIR:-/tmp}/gwanje_debate_turn.txt"

make_prompt () {   # $1=이름 $2=관점 $3=라운드
  local name="$1" angle="$2" round="$3"
  local e_actor; e_actor="$(urlenc "$name")"
  local list_url="${URL}?token=${TOKEN}&action=discuss_list&project=${E_PROJECT}&topic=${E_TOPIC}"
  local add_url="${URL}?token=${TOKEN}&action=discuss_add&project=${E_PROJECT}&topic=${E_TOPIC}&actor=${e_actor}"

  local ref_block=""
  if [ -n "$REFS" ]; then
    ref_block="[0단계] 먼저 아래 파일들을 읽고 근거로 삼아라."$'\n'"$(echo "$REFS" | sed 's/^/ - /')"$'\n\n'
  fi

  local agree_line
  if [ "$round" -le "$NOAGREE" ]; then
    agree_line="이번 라운드에서는 [합의] 를 붙이지 마라. 아직 충분히 주고받지 않았다."
  else
    agree_line="정말 더 논할 것이 없을 때에만 발언 맨 앞에 [합의] 를 붙이고 결론을 정리하라."
  fi

  cat > "$PROMPT_FILE" <<EOF
너는 협업 앱 "관제판"의 토론 참가자 "$name" 이다. 자동 토론이 진행 중이고, 이번엔 딱 한 턴만 발언한다.
${angle:+너의 검토 관점: $angle}

${ref_block}[1단계] 아래 주소로 HTTP GET 요청을 보내 지금까지의 토론 글을 읽어라 (주소를 그대로 사용):
$list_url

[2단계] 주제 "$TOPIC" 의 흐름을 보고, 네 관점에서 "다음 한 마디"를 정해라.
 - $RULES
 - $agree_line

[3단계] 아래 주소로 HTTP GET 요청을 보내 글을 올려라. TEXT_HERE 자리에 네 발언을 URL 인코딩해서 넣어라.
(답글이면 주소 끝에 &parent=상대의최신글ID 도 붙여라):
${add_url}&text=TEXT_HERE

끝나면 새 글ID 한 줄만 출력해라. 파일은 만들지 마라.
EOF
}

run_agent () {   # $1=cli $2=model $3=effort $4=extra $5=readcmd
  local cli="$1" model="$2" effort="$3" extra="$4" read="$5"
  case "$cli" in
    claude)
      if [ -n "$model" ]; then claude -p "$read" --model "$model" --dangerously-skip-permissions
      else                     claude -p "$read" --dangerously-skip-permissions; fi ;;
    codex)
      local a=(exec --dangerously-bypass-approvals-and-sandbox)
      [ -n "$model" ]  && a+=(-m "$model")
      [ -n "$effort" ] && a+=(-c "model_reasoning_effort=$effort")
      codex "${a[@]}" "$read" ;;
    hermes)
      hermes --yolo -z "$read" ;;
    *)
      if [ -n "$extra" ]; then $cli $extra "$read"; else $cli "$read"; fi ;;
  esac
}

READ="Read the UTF-8 text file at '$PROMPT_FILE' and do exactly what it says. Reply with only the new post ID."

echo "=================================================="
echo " 자동토론 시작 — 주제: $TOPIC"
echo " 참가자 ${#IDX[@]}명: $NAMES"
echo " 최대 ${ROUNDS} 라운드. 관제판 앱 '토론' 탭에서 실시간으로 쌓이는 걸 보세요."
echo "=================================================="

for ((r=1; r<=ROUNDS; r++)); do
  echo ""; echo "###### 라운드 $r / $ROUNDS ######"
  for i in "${IDX[@]}"; do
    nm_var="P${i}_NAME";   nm="${!nm_var}"
    cli_var="P${i}_CLI";   cli="${!cli_var}"
    md_var="P${i}_MODEL";  md="${!md_var}"
    ef_var="P${i}_EFFORT"; ef="${!ef_var}"
    an_var="P${i}_ANGLE";  an="${!an_var}"
    ex_var="P${i}_EXTRA";  ex="${!ex_var}"
    echo "----- $nm -----"
    make_prompt "$nm" "$an" "$r"
    run_agent "$cli" "$md" "$ef" "$ex" "$READ"
  done
  if curl -sL "${URL}?token=${TOKEN}&action=discuss_list&project=${E_PROJECT}&topic=${E_TOPIC}" | grep -q '\[합의\]'; then
    echo ">> [합의] 감지 → 토론 종료"; break
  fi
done

echo ""; echo "== 끝. 앱 '토론' 탭에서 주제 \"$TOPIC\" 을 확인하세요. =="
