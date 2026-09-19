#!/usr/bin/env bash
# ============================================================
#  관제판 자동토론 드라이버 (공용판, macOS / Linux / Git Bash)
#
#  게시판을 읽고 쓰는 일은 전부 이 드라이버가 한다.
#  참가 AI 는 "지금까지의 토론"을 프롬프트로 받고, 자기 발언만 파일에 적는다.
#   → 한글 인코딩을 한 곳에서만 처리하므로 어느 CLI를 붙여도 글이 깨지지 않는다.
#   → 앱 주소와 토큰이 AI 에게 넘어가지 않는다.
#
#  실행:
#     bash 자동토론_드라이버.sh
#     bash 자동토론_드라이버.sh "주제" 10
#
#  설정은 같은 폴더의 자동토론.config.json 에서 읽는다. (python3 · curl 필요)
#  ⚠ 모델 API 키를 쓰지 않는다. 각 CLI가 자기 구독으로 로그인돼 있어야 한다.
# ============================================================
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CFG="$HERE/자동토론.config.json"
MAXPOST=20

if [ ! -f "$CFG" ]; then
  echo "✗ 설정 파일이 없습니다: $CFG"
  echo "  → 같은 폴더의 '자동토론.config.example.json' 을 '자동토론.config.json' 으로 복사한 뒤"
  echo "    관제판 url·token 을 채우고 다시 실행하세요. (docs/2_자동토론_붙이기.md 참고)"
  exit 1
fi
command -v python3 >/dev/null 2>&1 || { echo "✗ python3 이 필요합니다."; exit 1; }
command -v curl    >/dev/null 2>&1 || { echo "✗ curl 이 필요합니다."; exit 1; }

eval "$(python3 - "$CFG" <<'PY'
import json, sys, shlex
d = json.load(open(sys.argv[1], encoding='utf-8'))
g = d.get('관제판', {}) or {}
t = d.get('토론', {}) or {}
def out(k, v): print("%s=%s" % (k, shlex.quote(str(v))))
out('URL',        g.get('url', ''))
out('TOKEN',      g.get('token', ''))
out('PROJECT',    g.get('project', '관제판') or '관제판')
out('CFG_TOPIC',  t.get('주제', ''))
out('CFG_ROUNDS', t.get('라운드', 8) or 8)
out('NOAGREE',    t.get('합의금지_라운드', 0) or 0)
out('MAXCALLS',   t.get('최대호출', 30) or 30)
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
[ -z "$TOPIC" ] && { echo "✗ 주제가 비어 있습니다."; exit 1; }

TMP="${TMPDIR:-/tmp}"
PROMPT_FILE="$TMP/gwanje_debate_turn.txt"
ANSWER_FILE="$TMP/gwanje_debate_answer.txt"
LIST_FILE="$TMP/gwanje_debate_list.json"
THREAD_FILE="$TMP/gwanje_debate_thread.txt"

# ---- 참가자 추리기 ----
IDX=(); NAMES=""
for ((i=0; i<NPART; i++)); do
  cli_var="P${i}_CLI"; cli="${!cli_var}"
  nm_var="P${i}_NAME"; nm="${!nm_var}"
  if command -v "$cli" >/dev/null 2>&1; then IDX+=("$i"); NAMES="${NAMES:+$NAMES, }$nm"
  else echo "↷ '$nm' 은(는) 건너뜁니다 — 명령 '$cli' 을 찾을 수 없습니다(미설치 또는 PATH 미등록)."; fi
done
if [ "${#IDX[@]}" -lt 1 ]; then
  echo "✗ 실행 가능한 참가자가 하나도 없습니다."
  echo "  → 점검: bash ../tools/점검.sh"
  exit 1
fi
[ "${#IDX[@]}" -lt 2 ] && echo "⚠ 참가자가 ${#IDX[@]}명뿐입니다. 토론이 되려면 둘 이상을 권합니다."

# ---- 관제판 호출 (인코딩은 여기서만 처리) ----
fetch_thread () {   # 성공 0 / 실패 1. THREAD_FILE 과 LAST_ID 를 채운다.
  if ! curl -sL -G "$URL" \
        --data-urlencode "token=$TOKEN" \
        --data-urlencode "action=discuss_list" \
        --data-urlencode "project=$PROJECT" \
        --data-urlencode "topic=$TOPIC" -o "$LIST_FILE"; then
    echo "  ✗ 관제판 통신 실패"; return 1
  fi
  LAST_ID="$(python3 - "$LIST_FILE" "$THREAD_FILE" "$MAXPOST" <<'PY'
import json, sys, io
try:
    d = json.load(open(sys.argv[1], encoding='utf-8'))
except Exception:
    sys.stderr.write("  ✗ 응답을 해석하지 못했습니다\n"); sys.exit(2)
if not d.get('ok'):
    sys.stderr.write("  ✗ 목록 실패: %s\n" % d.get('error')); sys.exit(2)
items = d.get('items') or []
recent = items[-int(sys.argv[3]):]
body = "\n\n".join("── %s ──\n%s" % (x.get('actor',''), x.get('text','')) for x in recent)
io.open(sys.argv[2], "w", encoding="utf-8").write(body or "(아직 아무 글도 없다. 네가 첫 발언을 한다.)")
print(items[-1]['id'] if items else "")
PY
)" || return 1
  return 0
}

post_answer () {   # $1=actor $2=parent
  local actor="$1" parent="$2" args=()
  args=(--data-urlencode "token=$TOKEN" --data-urlencode "action=discuss_add"
        --data-urlencode "project=$PROJECT" --data-urlencode "topic=$TOPIC"
        --data-urlencode "actor=$actor" --data-urlencode "text@$ANSWER_FILE")
  [ -n "$parent" ] && args+=(--data-urlencode "parent=$parent")
  curl -sL -G "$URL" "${args[@]}"
}

make_prompt () {   # $1=이름 $2=관점 $3=라운드
  local name="$1" angle="$2" round="$3" agree ref=""
  if [ "$round" -le "$NOAGREE" ]; then
    agree="이번 라운드에서는 [합의] 를 붙이지 마라. 아직 충분히 주고받지 않았다."
  else
    agree="정말 더 논할 것이 없을 때에만 발언 맨 앞에 [합의] 를 붙이고 결론을 정리하라."
  fi
  [ -n "$REFS" ] && ref="먼저 아래 파일들을 읽고 근거로 삼아라."$'\n'"$(echo "$REFS" | sed 's/^/ - /')"$'\n\n'

  {
    echo "너는 토론 참가자 \"$name\" 이다. 주제는 \"$TOPIC\" 이고, 이번엔 딱 한 턴만 발언한다."
    [ -n "$angle" ] && echo "너의 검토 관점: $angle"
    echo ""
    [ -n "$ref" ] && printf '%s' "$ref"
    echo "[지금까지의 토론]"
    cat "$THREAD_FILE"
    echo ""
    echo ""
    echo "[할 일]"
    echo "위 흐름을 읽고, 네 관점에서 \"다음 한 마디\"를 정해라."
    echo " - $RULES"
    echo " - $agree"
    echo ""
    echo "[출력 방법]"
    echo "네 발언 본문만 아래 파일에 UTF-8 로 저장해라. 저장이 곧 발언이다."
    echo "$ANSWER_FILE"
    echo ""
    echo "제목·머리말·설명·따옴표 없이 발언 본문만 넣어라. 다른 파일을 만들거나 고치지 마라."
    echo "웹 요청은 하지 마라 — 게시판에 올리는 일은 드라이버가 한다."
  } > "$PROMPT_FILE"
}

run_agent () {   # $1=cli $2=model $3=effort $4=extra $5=readcmd
  local cli="$1" model="$2" effort="$3" extra="$4" read="$5"
  local a=()
  case "$cli" in
    claude)
      a=(-p "$read" --dangerously-skip-permissions)
      [ -n "$model" ] && a+=(--model "$model")
      [ -n "$extra" ] && a+=($extra)
      claude "${a[@]}" >/dev/null 2>&1 ;;
    codex)
      a=(exec --dangerously-bypass-approvals-and-sandbox)
      [ -n "$model" ]  && a+=(-m "$model")
      [ -n "$effort" ] && a+=(-c "model_reasoning_effort=$effort")
      [ -n "$extra" ]  && a+=($extra)
      a+=("$read")
      codex "${a[@]}" >/dev/null 2>&1 ;;
    hermes)
      a=(--yolo -z)
      [ -n "$extra" ] && a+=($extra)
      a+=("$read")
      hermes "${a[@]}" >/dev/null 2>&1 ;;
    *)
      [ -n "$extra" ] && a+=($extra)
      a+=("$read")
      "$cli" "${a[@]}" >/dev/null 2>&1 ;;
  esac
}

READ="Read the UTF-8 text file at '$PROMPT_FILE' and do exactly what it says. Write your answer to the file it names. Do not print the answer."

echo "=================================================="
echo " 자동토론 시작 — 주제: $TOPIC"
echo " 참가자 ${#IDX[@]}명: $NAMES"
EXPECT=$(( ${#IDX[@]} * ROUNDS ))
echo " 최대 ${ROUNDS} 라운드"
echo " 예상 AI 호출: ${#IDX[@]}명 x ${ROUNDS}라운드 = 최대 ${EXPECT}회  (상한 ${MAXCALLS}회)"
[ "$EXPECT" -gt "$MAXCALLS" ] && echo " ⚠ 예상이 상한을 넘습니다. 상한에 닿으면 중간에 멈춥니다(설정의 토론.최대호출)."
echo " 관제판 앱 '토론' 탭에서 실시간으로 쌓이는 걸 보세요."
echo "=================================================="

AGREED=0
CAPPED=0
CALLS=0
for ((r=1; r<=ROUNDS && AGREED==0 && CAPPED==0; r++)); do
  echo ""; echo "###### 라운드 $r / $ROUNDS ######"
  for i in "${IDX[@]}"; do
    nm_var="P${i}_NAME";   nm="${!nm_var}"
    cli_var="P${i}_CLI";   cli="${!cli_var}"
    md_var="P${i}_MODEL";  md="${!md_var}"
    ef_var="P${i}_EFFORT"; ef="${!ef_var}"
    an_var="P${i}_ANGLE";  an="${!an_var}"
    ex_var="P${i}_EXTRA";  ex="${!ex_var}"
    if [ "$CALLS" -ge "$MAXCALLS" ]; then
      echo "‖ 호출 상한 ${MAXCALLS}회에 도달해 멈춥니다. 더 돌리려면 설정의 토론.최대호출 을 올리세요."
      CAPPED=1; break
    fi
    echo "----- $nm -----  (호출 $((CALLS + 1))/${MAXCALLS})"

    LAST_ID=""
    if ! fetch_thread; then echo "  ↷ 게시판을 읽지 못해 이 턴을 건너뜁니다."; continue; fi

    rm -f "$ANSWER_FILE"
    make_prompt "$nm" "$an" "$r"
    CALLS=$((CALLS + 1))
    run_agent "$cli" "$md" "$ef" "$ex" "$READ"

    if [ ! -s "$ANSWER_FILE" ]; then
      echo "  ↷ 발언 파일이 비었거나 만들어지지 않았습니다. 이 턴은 건너뜁니다."; continue
    fi
    echo "  말: $(tr '\n' ' ' < "$ANSWER_FILE" | cut -c1-70)…"

    RES="$(post_answer "$nm" "$LAST_ID")"
    if echo "$RES" | grep -q '"ok":true'; then
      echo "  ✓ 올림: $(echo "$RES" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("id",""))' 2>/dev/null)"
      if grep -q '\[합의\]' "$ANSWER_FILE"; then echo ">> [합의] → 토론 종료"; AGREED=1; break; fi
    else
      echo "  ✗ 올리기 실패: $RES"
      echo "$RES" | grep -q unknown_actor   && echo "     → 시트 '설정' 탭 행위자목록에 '$nm' 을(를) 추가하세요."
      echo "$RES" | grep -q unknown_project && echo "     → 시트 '설정' 탭 프로젝트목록에 '$PROJECT' 을(를) 추가하세요."
    fi
  done
done

echo ""; echo "== 끝. 앱 '토론' 탭에서 주제 \"$TOPIC\" 을 확인하세요. =="
