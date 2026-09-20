#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
관제판 작업 드라이버 — 보드의 '할일' 카드를 담당 AI(CLI)가 실제로 처리한다.

  잡았다 → 작업 → 풀기 릴레이를, 이번엔 "코드 수정"에 그대로 적용한다.
  사람은 보드에 개선 카드만 올리고, 이 드라이버를 한 줄로 돌리면:
    할일 카드를 읽어 → 카드의 담당에 맞는 CLI를 불러 대상 파일을 고치게 하고 → 카드를 끝으로 옮긴다.

  ── 설계 (자동토론 드라이버 v1.3 원칙 그대로) ──
   1) 게시판 I/O(claim·release·card_move·log)는 전부 이 드라이버가 한다. 앱 주소·토큰은 AI에게 넘기지 않는다.
   2) 코어는 이 파일 하나. .ps1·.sh 는 파이썬을 찾아 넘기는 껍데기다(tools/점검 방식).
   3) 설정은 client/gwanje.config.json(url·token·project·actor) 을 재사용하고, "작업" 블록만 더 읽는다.
   4) 비용 상한: 한 번에 처리할 최대 카드 수를 두고, 실행 전 확인 1회.
   5) 사전검증은 실제 작업과 똑같은 실행 경로로 부른다(그래야 대상이 아니라 그 방식을 검증하는 사고를 막는다).
   6) 병렬(옵션): 여러 카드를 담당별로 동시에 처리한다. 같은 파일을 가리키는 카드는
      자동으로 순서대로 돌려 충돌을 막는다(설정 작업.병렬 / 최대동시).

  ⚠ 작업 CLI는 파일쓰기 권한(claude --dangerously-skip-permissions 등)으로 돈다.
     실행 범위를 '작업폴더' 하나로 한정하되, 지울 수 없는 중요한 원본이 든 폴더에서는 돌리지 마라.

  실행:
     python 작업드라이버.py                 # client 설정의 project 를 once 모드로 1회 처리
     python 작업드라이버.py 내프로젝트 once
     python 작업드라이버.py 내프로젝트 watch  # 폴링(옵션)
"""
import io, json, os, re, shutil, subprocess, sys, tempfile, threading, time
import urllib.parse, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)                 # 저장소 루트 = 기본 작업폴더
CONFIG = os.path.join(ROOT, "client", "gwanje.config.json")

# 프롬프트는 매 실행마다 임시폴더에 '고유' 파일로 쓰고 CLI에게 "그 파일 읽어라"로 넘긴다:
#  - 긴 한글 프롬프트를 명령줄 인자로 넘기면 윈도우에서 깨지거나 잘린다. ASCII 경로가 안전하다.
#  - 병렬로 여러 CLI를 돌릴 때 프롬프트가 서로 안 섞이도록 파일을 매번 새로 만든다.
TMP = tempfile.gettempdir()

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")   # 윈도우 콘솔(CP949) 기호 깨짐 예방
except Exception:
    pass

HEARTBEAT_SEC = 1800     # 긴 작업이면 30분마다 잠금 연장
POLL_SEC = 20            # watch 모드 폴링 간격
PLACEHOLDER = re.compile(r"여기에|<.*>|\.\.\.|…|YOUR_|xxx", re.I)

# 병렬 출력이 뒤섞이지 않게 화면 출력은 한 곳으로 모은다.
PRINT_LOCK = threading.Lock()


def say(msg):
    with PRINT_LOCK:
        print(msg)
        try:
            sys.stdout.flush()
        except Exception:
            pass


def _rm(path):
    try:
        os.remove(path)
    except Exception:
        pass


def die(msg, code=2):
    print("✗ " + msg)
    sys.exit(code)


# ---------------------------------------------------------------- 설정
def load_config():
    if not os.path.exists(CONFIG):
        die("설정 파일이 없습니다: client/gwanje.config.json\n"
            "  → client/gwanje.config.example.json 을 복사해 url·token·project·actor 를 채우세요.")
    try:
        cfg = json.load(io.open(CONFIG, encoding="utf-8"))
    except Exception as e:
        die("설정 파일 JSON 형식 오류: %s" % e)
    url = (cfg.get("url") or "").strip()
    token = (cfg.get("token") or "").strip()
    if not url or not token or PLACEHOLDER.search(url) or PLACEHOLDER.search(token):
        die("설정의 url 또는 token 이 비었거나 자리표시자입니다.\n"
            "  → url 은 배포한 웹앱 주소(…/exec), token 은 시트 설정 탭의 24자리 값입니다.")
    return cfg


# ---------------------------------------------------------------- 관제판 호출 (인코딩은 여기서만)
def api(cfg, action, params, timeout=30):
    q = {"token": cfg["token"], "action": action}
    q.update(params or {})
    url = cfg["url"] + "?" + urllib.parse.urlencode(q, encoding="utf-8")
    req = urllib.request.Request(url, headers={"User-Agent": "gwanje-work/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace")
    except Exception as e:
        return {"ok": False, "error": "통신 실패", "detail": str(e)}
    try:
        return json.loads(raw)
    except Exception:
        return {"ok": False, "error": "JSON 아님", "detail": raw[:200]}


# ---------------------------------------------------------------- CLI 실행 (자동토론 run_agent 와 동일 규칙)
def build_args(worker, prompt):
    """cli 뒤에 붙을 인자 목록만 반환한다(cli 실행파일 해석은 resolve_cmd 에서)."""
    cli = worker["cli"]
    model = (worker.get("모델") or "").strip()
    effort = (worker.get("추론강도") or "").strip()
    extra = worker.get("실행인자") or []
    if cli == "claude":
        a = ["-p", prompt, "--dangerously-skip-permissions"]
        if model: a += ["--model", model]
        a += extra
    elif cli == "codex":
        a = ["exec", "--dangerously-bypass-approvals-and-sandbox"]
        if model: a += ["-m", model]
        if effort: a += ["-c", "model_reasoning_effort=%s" % effort]
        a += extra
        a += [prompt]
    elif cli == "hermes":
        a = ["--yolo", "-z"] + list(extra) + [prompt]
    else:
        a = list(extra) + [prompt]
    return a


def resolve_cmd(cli, args):
    """윈도우에서 npm 설치형 CLI는 claude.cmd 같은 배치 껍데기라, 바로 못 부른다.
       shutil.which 로 실제 경로를 찾고, .cmd/.bat 이면 cmd /c 로 감싼다(PowerShell '&' 와 같은 효과)."""
    exe = shutil.which(cli) or cli
    if os.name == "nt" and exe.lower().endswith((".cmd", ".bat")):
        return ["cmd", "/c", exe] + args
    return [exe] + args


def run_agent(worker, prompt_text, cwd, timeout=None, on_beat=None):
    """프롬프트를 '고유' 임시파일에 쓰고, CLI에게 그 파일을 읽어 실행하게 한다.
       (성공여부 bool, 마지막 한 줄 요약, 사유) 반환.
       ※ 출력을 대기 중에도 계속 읽어 비운다(파이프 버퍼가 차서 CLI가 멈추는 교착을 막기 위함).
       ※ 프롬프트 파일을 매번 새로 만들어, 병렬로 여러 CLI가 돌아도 서로 안 섞인다."""
    try:
        fd, prompt_file = tempfile.mkstemp(prefix="gwanje_work_", suffix=".txt", dir=TMP)
        os.close(fd)
        io.open(prompt_file, "w", encoding="utf-8").write(prompt_text)
    except Exception as e:
        return False, "", "프롬프트 파일을 쓰지 못했습니다: %s" % e

    read_instr = "Read the UTF-8 text file at '%s' and do exactly what it says." % prompt_file
    args = build_args(worker, read_instr)
    cmd = resolve_cmd(worker["cli"], args)
    try:
        p = subprocess.Popen(cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    except FileNotFoundError:
        _rm(prompt_file)
        return False, "", "명령 '%s' 을 찾을 수 없습니다" % worker["cli"]
    except Exception as e:
        _rm(prompt_file)
        return False, "", "실행 오류: %s" % e

    # 출력을 백그라운드에서 계속 읽어 파이프를 비운다(교착 방지).
    chunks = []
    def _drain():
        try:
            for line in iter(p.stdout.readline, b""):
                chunks.append(line)
        except Exception:
            pass
    reader = threading.Thread(target=_drain)
    reader.daemon = True
    reader.start()

    try:
        start = time.time()
        last_beat = start
        while True:
            if p.poll() is not None:
                break
            time.sleep(1)
            now = time.time()
            if timeout and (now - start) > timeout:
                p.kill()
                reader.join(timeout=5)
                return False, "", "제한시간(%d초) 초과" % timeout
            if on_beat and (now - last_beat) >= HEARTBEAT_SEC:
                on_beat()
                last_beat = now
        reader.join(timeout=5)
        try:
            p.stdout.close()
        except Exception:
            pass
        out = (b"".join(chunks)).decode("utf-8", "replace")
        tail = ""
        for line in reversed(out.splitlines()):
            if line.strip():
                tail = line.strip()[:120]
                break
        if p.returncode != 0:
            return False, tail, "CLI가 오류로 끝났습니다(코드 %s)" % p.returncode
        return True, tail, ""
    finally:
        _rm(prompt_file)


def test_agent(worker):
    """실제 작업과 똑같은 실행 경로(run_agent)로 한 번 불러 본다. 통과=None, 실패=이유."""
    probe = os.path.join(TMP, "gwanje_probe_%s.txt" % worker["cli"])
    try:
        if os.path.exists(probe): os.remove(probe)
    except Exception:
        pass
    cmd = ("Write exactly the word READY (nothing else) to the UTF-8 text file at '%s'. "
           "Do not print anything. Do not create or modify any other file." % probe)
    ok, _, why = run_agent(worker, cmd, cwd=HERE, timeout=None)
    if not os.path.exists(probe):
        if why:   # 실행 자체가 안 된 경우(명령 못 찾음 등) 진짜 사유를 보여준다
            return why
        return "불렀지만 파일을 쓰지 못했습니다 — 로그인 안 됨 · 구독 한도 초과 · 모델 이름 오류 중 하나입니다"
    try:
        v = io.open(probe, encoding="utf-8", errors="replace").read()
        os.remove(probe)
    except Exception:
        v = ""
    if "READY" not in v:
        return "대답이 지시와 다릅니다 — 이 CLI로는 파일 쓰기 지시가 먹지 않습니다"
    return None


# ---------------------------------------------------------------- 작업 프롬프트
def make_prompt(card, rule):
    resource = card.get("resource", "")
    memo = card.get("memo", "") or card.get("title", "")
    lines = [
        "너는 이 저장소에서 코드를 고치는 작업자다. 딱 이 카드 하나만 처리한다.",
        "",
        "대상 파일: %s" % (resource or "(카드에 관련자원이 비어 있음 — 지시를 보고 알맞은 파일만)"),
        "지시: %s" % memo,
        "",
        "규칙:",
        " - 대상 파일만 고쳐라. 다른 파일은 만들거나 지우지 마라.",
    ]
    if rule:
        lines.append(" - %s" % rule)
    lines += [
        "",
        "다 끝나면 무엇을 바꿨는지 한 줄로만 출력해라. 설명을 길게 하지 마라.",
    ]
    return "\n".join(lines)


# ---------------------------------------------------------------- 카드 한 장 처리 (잡기→하는중→작업→끝/되돌림)
def process_card(cfg, project, actor, card, worker, workdir, rule, timeout, label=""):
    cid = card["id"]
    resource = card.get("resource") or card.get("title") or cid
    title = card.get("title", "")
    tag = ("[%s] " % label) if label else ""
    say("  %s----- %s -----  담당 %s(%s)  자원 %s" % (tag, title, card.get("assignee"), worker["cli"], resource))

    # 1) 잡기 — 남이 잡은 파일이면 건너뛴다(교통정리)
    r = api(cfg, "claim", {"project": project, "resource": resource, "actor": actor,
                           "memo": "작업시작 " + cid})
    if not r.get("ok"):
        if r.get("error") == "locked":
            say("    %s↷ '%s' 은(는) %s 가 잡고 있어 건너뜁니다." % (tag, resource, r.get("by")))
            api(cfg, "log", {"project": project, "actor": actor, "text": "%s 건너뜀 — %s 가 잡음" % (cid, r.get("by"))})
        else:
            say("    %s✗ 잡기 실패: %s" % (tag, r.get("error")))
        return "skip"

    # 2) 하는중 표시
    api(cfg, "card_move", {"cardId": cid, "status": "하는중", "actor": actor})

    # 3) 담당 CLI 실행 (작업폴더에서 파일쓰기)
    def beat():
        api(cfg, "heartbeat", {"project": project, "resource": resource, "actor": actor})
    prompt = make_prompt(card, rule)
    ok, tail, why = run_agent(worker, prompt, cwd=workdir, timeout=timeout, on_beat=beat)

    if ok:
        api(cfg, "release", {"project": project, "resource": resource, "actor": actor})
        api(cfg, "card_move", {"cardId": cid, "status": "끝", "actor": actor})
        api(cfg, "log", {"project": project, "actor": actor, "text": "%s 완료 — %s" % (cid, tail or "요약 없음")})
        say("    %s✓ 완료 → 끝. %s" % (tag, tail or ""))
        return "done"
    else:
        # 되돌림: 놓고 → 할일로 → 사유 기록
        api(cfg, "release", {"project": project, "resource": resource, "actor": actor})
        api(cfg, "card_move", {"cardId": cid, "status": "할일", "actor": actor})
        api(cfg, "log", {"project": project, "actor": actor, "text": "%s 실패 — %s" % (cid, why)})
        say("    %s✗ 실패 → 할일로 되돌림. %s" % (tag, why))
        return "fail"


# ---------------------------------------------------------------- 병렬: 같은 파일은 드라이버 안에서도 순서대로
# 한 드라이버는 같은 이름(actor)으로 여러 CLI를 부르는데, 보드 잠금은 '같은 actor 재잡기'를 통과시킨다.
# 그래서 같은 자원(파일)을 가리키는 카드가 동시에 돌면 충돌한다 → 자원별 잠금으로 순서를 보장한다.
_RES_LOCKS = {}
_RES_LOCKS_GUARD = threading.Lock()


def resource_lock(resource):
    with _RES_LOCKS_GUARD:
        lk = _RES_LOCKS.get(resource)
        if lk is None:
            lk = threading.Lock()
            _RES_LOCKS[resource] = lk
        return lk


def run_parallel(cfg, project, actor, roster, workdir, rule, timeout, plan, max_concurrent):
    sem = threading.Semaphore(max_concurrent)
    results = []
    rlock = threading.Lock()
    threads = []

    def go(card, worker):
        resource = card.get("resource") or card.get("title") or card["id"]
        rl = resource_lock(resource)
        with rl:                       # 같은 파일 카드는 한 번에 하나만(충돌 방지)
            sem.acquire()              # 동시 실행 수 상한
            try:
                res = process_card(cfg, project, actor, card, worker,
                                   workdir, rule, timeout, label=card.get("assignee") or "")
            finally:
                sem.release()
        with rlock:
            results.append(res)

    for card in plan:
        who = card.get("assignee")
        worker = roster.get(who)
        if not worker:
            say("  ↷ %s — 담당 '%s' 의 CLI를 못 찾아 건너뜁니다(설정 작업.담당 확인)." % (card.get("title"), who))
            api(cfg, "log", {"project": project, "actor": actor,
                             "text": "%s 건너뜀 — 담당 %s CLI 없음" % (card["id"], who)})
            continue
        t = threading.Thread(target=go, args=(card, worker))
        t.start()
        threads.append(t)

    for t in threads:
        t.join()
    return sum(1 for r in results if r in ("done", "fail"))


# ---------------------------------------------------------------- 한 바퀴 (밀린 할일 카드 처리)
PRI_ORDER = {"높음": 0, "보통": 1, "낮음": 2}


def one_pass(cfg, project, actor, roster, workdir, rule, max_cards, timeout, max_concurrent=1):
    r = api(cfg, "card_list", {"project": project})
    if not r.get("ok"):
        say("✗ 카드 목록 실패: %s" % r.get("error"))
        return 0
    todo = [c for c in r.get("cards", []) if c.get("status") == "할일"]
    todo.sort(key=lambda c: (PRI_ORDER.get(c.get("priority"), 1), c.get("created", "")))

    if not todo:
        say("  · 처리할 '할일' 카드가 없습니다.")
        return 0

    plan = todo[:max_cards]

    # 병렬: 카드가 2개 이상이고 최대동시>1 이면 동시에 처리
    if max_concurrent and max_concurrent > 1 and len(plan) > 1:
        say("  예상: %d개 카드 처리 — 한 번에 최대 %d개 동시 (할일 %d개 중 상한 %d)"
            % (len(plan), max_concurrent, len(todo), max_cards))
        return run_parallel(cfg, project, actor, roster, workdir, rule, timeout, plan, max_concurrent)

    # 순차
    say("  예상: %d개 카드 처리 (할일 %d개 중 상한 %d)" % (len(plan), len(todo), max_cards))
    done = 0
    for card in plan:
        who = card.get("assignee")
        worker = roster.get(who)
        if not worker:
            say("  ----- %s -----  ↷ 담당 '%s' 의 CLI를 못 찾아 건너뜁니다(설정 작업.담당 확인)." % (card.get("title"), who))
            api(cfg, "log", {"project": project, "actor": actor, "text": "%s 건너뜀 — 담당 %s CLI 없음" % (card["id"], who)})
            continue
        result = process_card(cfg, project, actor, card, worker, workdir, rule, timeout)
        if result in ("done", "fail"):
            done += 1
    return done


# ---------------------------------------------------------------- 메인
def main():
    cfg = load_config()
    work = cfg.get("작업") or {}
    project = (sys.argv[1] if len(sys.argv) >= 2 else "") or (cfg.get("project") or "").strip()
    mode = (sys.argv[2] if len(sys.argv) >= 3 else "") or (work.get("모드") or "once")
    actor = (cfg.get("actor") or "").strip()
    if not project: die("project 가 비어 있습니다. 인자로 주거나 설정의 project 를 채우세요.")
    if not actor:   die("actor 가 비어 있습니다. 설정의 actor 를 채우세요(시트 행위자목록에 있는 이름).")

    workdir = (work.get("작업폴더") or "").strip() or ROOT
    rule = (work.get("작업규칙") or "").strip()
    max_cards = int(work.get("최대카드") or 5)
    timeout = int(work.get("카드제한초") or 0) or None
    precheck = work.get("사전검증", True) is not False
    parallel = work.get("병렬") is True
    max_concurrent = max(1, int(work.get("최대동시") or 3)) if parallel else 1

    # 담당 로스터: 설정 작업.담당 → {이름: worker}. CLI가 PATH에 있어야 참가.
    roster = {}
    for w in (work.get("담당") or []):
        if w.get("사용") is False or not w.get("cli") or not w.get("이름"):
            continue
        if shutil.which(w["cli"]):
            roster[w["이름"]] = w
        else:
            print("↷ '%s' 은(는) 뺍니다 — 명령 '%s' 을 찾을 수 없습니다(미설치 또는 PATH 미등록)." % (w["이름"], w["cli"]))
    if not roster:
        die("작업 가능한 담당 CLI가 하나도 없습니다.\n"
            "  → 설정 작업.담당 의 cli 이름을 확인하고, 그 CLI를 설치·로그인하세요.\n"
            "  → 점검: python tools/점검.py")

    # 사전검증 — 실제 작업과 똑같은 방식으로 각 CLI를 한 번 불러 본다
    if precheck:
        print("\n── 담당 사전검증 (각 CLI를 한 번씩 짧게 불러 봅니다) ──")
        print("   한 CLI에서 오래 멈춰 있으면 로그인 창을 기다리는 중입니다 → Ctrl+C 후 그 CLI를 직접 실행해 로그인하세요.")
        alive = {}
        seen = {}
        for name, w in roster.items():
            key = w["cli"]
            if key in seen:                      # 같은 CLI는 한 번만 검증
                if seen[key] is None: alive[name] = w
                continue
            print("  · %s (%s) 확인 중…" % (name, key), end="", flush=True)
            why = test_agent(w)
            seen[key] = why
            if why:
                print("\n    ✗ 제외 — %s" % why)
            else:
                print(" 응답함 ✓")
                alive[name] = w
        roster = alive
        if not roster:
            die("대답하는 담당 CLI가 하나도 없습니다. 작업을 시작하지 않습니다.\n"
                "  → 각 CLI를 터미널에서 직접 실행해 로그인 상태를 확인하세요.\n"
                "  → 검증을 건너뛰려면 설정 작업.사전검증 을 false 로 두세요.")

    # 연결·이름 확인
    st = api(cfg, "status", {"project": project})
    if not st.get("ok"):
        die("관제판에 연결하지 못했습니다: %s" % st.get("error"))
    actors = st.get("actors", [])
    if actor not in actors:
        die("actor '%s' 가 시트 행위자목록에 없습니다: %s" % (actor, ", ".join(actors)))

    print("\n==================================================")
    print(" 작업 드라이버 시작 — 프로젝트: %s · 나: %s · 모드: %s" % (project, actor, mode))
    print(" 담당: %s" % ", ".join("%s(%s)" % (n, w["cli"]) for n, w in roster.items()))
    print(" 작업폴더: %s" % workdir)
    if parallel:
        print(" 병렬 실행 — 한 번에 최대 %d개 카드를 동시에 처리합니다(같은 파일은 순서대로)." % max_concurrent)
    print(" 한 바퀴 최대 %d개 카드 처리 (상한)" % max_cards)
    print(" ⚠ 담당 CLI는 파일쓰기 권한으로 이 폴더에서 돕니다. 중요한 원본이 있으면 먼저 백업하세요.")
    print("==================================================")

    # 실행 전 확인 1회 (사람이 있으면)
    if sys.stdin.isatty() and not os.environ.get("GWANJE_YES"):
        try:
            input(" 진행하려면 Enter, 취소는 Ctrl+C … ")
        except (KeyboardInterrupt, EOFError):
            print("\n취소했습니다."); return

    if mode == "watch":
        print(" watch 모드 — %d초마다 새 할일 카드를 확인합니다. 멈추려면 Ctrl+C." % POLL_SEC)
        try:
            while True:
                one_pass(cfg, project, actor, roster, workdir, rule, max_cards, timeout, max_concurrent)
                time.sleep(POLL_SEC)
        except KeyboardInterrupt:
            print("\n== 멈춤. ==")
    else:
        n = one_pass(cfg, project, actor, roster, workdir, rule, max_cards, timeout, max_concurrent)
        print("\n== 끝. 이번 바퀴에 %d개 카드를 처리했습니다. 앱 '작업보드'·'작업일지' 탭에서 확인하세요. ==" % n)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n중단했습니다.")
