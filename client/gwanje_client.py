#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
관제판 클라이언트 (gwanje_client.py)
====================================
AI 협업 관제판(구글 앱스스크립트 웹앱)을 깔끔한 명령어로 감싼다.
헤르메스(또는 사람)가 매번 손으로 curl 에 한글 %인코딩을 넣다 깨지는 일을 없앤다.

■ 무엇을 대신 해주나
  - 한글/공백 값 UTF-8 퍼센트 인코딩 (직접 안 해도 됨)
  - 앱스스크립트 302 리다이렉트 자동 추적
  - 응답 JSON 파싱 + 사람이 읽기 좋은 출력 (--json 이면 원문)
  - ok:false 이면 종료코드 1 (스크립트/자동화에서 실패 감지 쉬움)
  - URL·토큰·기본 actor/project 를 설정파일 또는 환경변수에서 읽음 (코드에 안 박음)

■ 설정 (우선순위: 명령행 > 환경변수 > 설정파일)
  설정파일: 이 스크립트와 같은 폴더의 gwanje.config.json  (--config 로 변경 가능)
    { "url": "...exec", "token": "...", "actor": "헤르메스", "project": "관제판" }
  환경변수: GWANJE_URL, GWANJE_TOKEN, GWANJE_ACTOR, GWANJE_PROJECT

■ 예시
  python gwanje_client.py status
  python gwanje_client.py claim Code.gs --memo "로트 함수 수정"
  python gwanje_client.py release Code.gs
  python gwanje_client.py log "작업 시작"
  python gwanje_client.py poll                 # 지금 나에게 필요한 게 뭔지 한눈에
  python gwanje_client.py poll --watch          # 상시 감시 (헤르메스용)
  python gwanje_client.py raw status project=관제판   # 임의 액션 직접 호출

의존성 없음(파이썬 표준 라이브러리만). 파이썬 3.7+.
"""

import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CONFIG = os.path.join(HERE, "gwanje.config.json")


# ----------------------------------------------------------------------
# 설정 로딩
# ----------------------------------------------------------------------
def load_config(path):
    cfg = {"url": "", "token": "", "actor": "", "project": ""}
    if path and os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            for k in cfg:
                if data.get(k):
                    cfg[k] = str(data[k]).strip()
        except Exception as e:
            eprint("설정파일 읽기 실패(%s): %s" % (path, e))
    # 환경변수가 있으면 덮어씀
    for k, env in (("url", "GWANJE_URL"), ("token", "GWANJE_TOKEN"),
                   ("actor", "GWANJE_ACTOR"), ("project", "GWANJE_PROJECT")):
        v = os.environ.get(env)
        if v:
            cfg[k] = v.strip()
    return cfg


def eprint(*a):
    print(*a, file=sys.stderr)


# ----------------------------------------------------------------------
# 호출
# ----------------------------------------------------------------------
def build_url(cfg, action, params):
    if not cfg.get("url"):
        die("url 이 설정되지 않았습니다. gwanje.config.json 또는 GWANJE_URL 을 채우세요.")
    if not cfg.get("token"):
        die("token 이 설정되지 않았습니다. gwanje.config.json 또는 GWANJE_TOKEN 을 채우세요. (구글시트 설정 탭)")
    q = {"token": cfg["token"], "action": action}
    for k, v in params.items():
        if v is None:
            continue
        q[k] = v
    # urlencode 가 UTF-8 퍼센트 인코딩을 알아서 해줌
    return cfg["url"] + "?" + urllib.parse.urlencode(q, encoding="utf-8")


def mask_token(u, token):
    if token:
        return u.replace(token, "<토큰>")
    return u


def call(cfg, action, params, timeout=30):
    url = build_url(cfg, action, params)
    req = urllib.request.Request(url, headers={"User-Agent": "gwanje-client/1.0"})
    # urllib 은 GET 의 301/302/303/307 리다이렉트를 기본으로 따라간다 (앱스스크립트 대응)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        die("HTTP %s: %s" % (e.code, e.reason))
    except urllib.error.URLError as e:
        die("연결 실패: %s" % e.reason)
    except Exception as e:
        die("호출 오류: %s" % e)
    try:
        return json.loads(raw)
    except Exception:
        die("JSON 이 아닌 응답입니다. 토큰/주소를 확인하세요.\n--- 응답 앞부분 ---\n" + raw[:400])


def die(msg, code=2):
    eprint("✗ " + msg)
    sys.exit(code)


# ----------------------------------------------------------------------
# 출력
# ----------------------------------------------------------------------
def emit(result, as_json):
    if as_json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        print(pretty(result))
    # ok:false 이면 종료코드 1
    if isinstance(result, dict) and result.get("ok") is False:
        sys.exit(1)


def pretty(r):
    if not isinstance(r, dict):
        return json.dumps(r, ensure_ascii=False, indent=2)
    if r.get("ok") is False:
        line = "✗ 실패: " + str(r.get("error"))
        extra = {k: v for k, v in r.items() if k not in ("ok", "error")}
        if extra:
            line += "  " + json.dumps(extra, ensure_ascii=False)
        return line
    # 성공 — 특징적인 응답들 보기 좋게
    if "locks" in r or "turn" in r:  # status
        out = ["● 상태  (%s)  현재차례: %s" % (r.get("now", ""), r.get("turn", ""))]
        locks = r.get("locks", [])
        out.append("  잠금 %d개:" % len(locks))
        for L in locks:
            out.append("    - [%s] %s  ← %s  (%s분 남음)  %s"
                       % (L.get("project"), L.get("resource"), L.get("actor"),
                          L.get("minutesLeft"), L.get("memo") or ""))
        doing = r.get("doing", [])
        if doing:
            out.append("  하는중 카드 %d개:" % len(doing))
            for c in doing:
                out.append("    - [%s] %s  ← %s" % (c.get("id"), c.get("title"), c.get("assignee")))
        out.append("  행위자: %s / 프로젝트: %s" % (", ".join(r.get("actors", [])), ", ".join(r.get("projects", []))))
        return "\n".join(out)
    if "cards" in r:  # card_list
        out = ["● 카드 %d개 (%s)" % (len(r["cards"]), r.get("project", ""))]
        for c in r["cards"]:
            out.append("  [%s] %-4s %-6s %s  ← %s  %s"
                       % (c.get("id"), c.get("status"), c.get("priority"),
                          c.get("title"), c.get("assignee"), ("· " + c["resource"]) if c.get("resource") else ""))
        return "\n".join(out)
    if "items" in r:  # discuss_list / request_list
        out = ["● 항목 %d개" % len(r["items"])]
        for it in r["items"]:
            if "text" in it:  # 토론
                pfx = ("  ↳ " if it.get("parent") else "  ")
                out.append("%s[%s] %s: %s  (%s)" % (pfx, it.get("id"), it.get("actor"), it.get("text"), it.get("time")))
            else:  # 수거요청
                out.append("  [%s] %s / %s / %s / %s" % (it.get("id"), it.get("status"), it.get("donor"), it.get("items"), it.get("wish_date")))
        return "\n".join(out)
    if "entries" in r:  # log_list
        out = ["● 일지 %d줄" % r.get("count", len(r["entries"]))]
        for e in r["entries"]:
            out.append("  %s  [%s] %s %s %s  %s"
                       % (e.get("at"), e.get("project"), e.get("actor"), e.get("action"), e.get("target"), e.get("detail")))
        return "\n".join(out)
    if "guides" in r:  # guide_list
        out = ["● 지시문 %d개" % len(r["guides"])]
        for g in r["guides"]:
            out.append("  [%s] %s  v%s  (%s)" % (g.get("id"), g.get("title"), g.get("version"), g.get("updated")))
        return "\n".join(out)
    if "prompt" in r:  # agent prompt
        return "● 에이전트 프롬프트:\n" + r["prompt"]
    return "✓ " + json.dumps({k: v for k, v in r.items() if k != "ok"}, ensure_ascii=False)


# ----------------------------------------------------------------------
# poll — 상시 감시: 지금 이 actor 에게 필요한 게 뭔가
# ----------------------------------------------------------------------
def do_poll(cfg, args):
    actor = args.actor or cfg.get("actor")
    project = args.project or cfg.get("project") or None
    if not actor:
        die("poll 은 actor 가 필요합니다. --actor 또는 설정파일에 지정하세요.")

    def snapshot():
        st = call(cfg, "status", {"project": project} if project else {})
        cards = call(cfg, "card_list", {"project": project} if project else {})
        lines = []
        my_turn = (st.get("turn") == actor)
        lines.append("── poll @ %s ─ actor:%s ─ 내차례:%s" % (st.get("now"), actor, "예" if my_turn else "아니오"))
        # 나에게 배분된, 아직 안 끝난 카드
        mine = [c for c in cards.get("cards", []) if c.get("assignee") == actor and c.get("status") != "끝"]
        if mine:
            lines.append("  ▶ 내 미완료 카드 %d개:" % len(mine))
            for c in mine:
                lines.append("     [%s] %-4s %s  %s" % (c.get("id"), c.get("status"), c.get("title"),
                                                        ("· " + c["resource"]) if c.get("resource") else ""))
        else:
            lines.append("  · 내게 배분된 미완료 카드 없음")
        # 남이 잡은 잠금 (내가 건드리면 안 되는 것)
        others = [L for L in st.get("locks", []) if L.get("actor") != actor]
        if others:
            lines.append("  · 남이 잠근 자원(건드리지 말 것): " + ", ".join("%s←%s" % (L.get("resource"), L.get("actor")) for L in others))
        return "\n".join(lines)

    if not args.watch:
        print(snapshot())
        return
    # watch 루프
    interval = max(5, args.interval)
    eprint("상시 감시 시작 (%d초 간격, Ctrl+C 로 중단)" % interval)
    try:
        while True:
            print(snapshot(), flush=True)
            print("", flush=True)
            time.sleep(interval)
    except KeyboardInterrupt:
        eprint("중단됨.")


# ----------------------------------------------------------------------
# doctor — 가동 준비 자가진단 (설정→연결→actor등록→쓰기왕복)
# ----------------------------------------------------------------------
def do_doctor(cfg, args):
    actor = args.actor or cfg.get("actor")
    project = args.project or cfg.get("project")
    ok_all = True

    def step(name, passed, hint=""):
        nonlocal ok_all
        mark = "✓" if passed else "✗"
        line = "  %s %s" % (mark, name)
        if not passed:
            ok_all = False
            if hint:
                line += "\n      → " + hint
        print(line)
        return passed

    print("── 관제판 가동 자가진단 ──")

    # 1) 설정
    has_url = bool(cfg.get("url"))
    has_token = bool(cfg.get("token"))
    step("설정: url 있음", has_url, "gwanje.config.json 의 url 또는 GWANJE_URL 을 채우세요.")
    step("설정: token 있음", has_token, "구글시트 설정 탭의 토큰을 gwanje.config.json 또는 GWANJE_TOKEN 에 넣으세요.")
    step("설정: actor 지정됨 (%s)" % (actor or "-"), bool(actor), "gwanje.config.json 의 actor 또는 GWANJE_ACTOR 를 '헤르메스' 로 지정하세요.")
    if not (has_url and has_token):
        print("\n✗ 설정이 비어 연결 단계로 못 넘어갑니다."); sys.exit(1)

    # 2) 연결 (status)
    try:
        st = call(cfg, "status", {"project": project} if project else {})
    except SystemExit:
        print("\n✗ 연결 실패. url/token 을 확인하세요."); sys.exit(1)
    connected = isinstance(st, dict) and st.get("ok") is True
    step("연결: status 응답 정상", connected,
         "토큰이 틀렸거나(unauthorized) 주소가 잘못됐습니다: " + str(st.get("error")) if not connected else "")
    if not connected:
        print("\n✗ 연결 안 됨."); sys.exit(1)
    actors = st.get("actors", [])
    projects = st.get("projects", [])
    print("      · 등록된 행위자: %s" % ", ".join(actors))
    print("      · 등록된 프로젝트: %s" % ", ".join(projects))
    print("      · 현재차례: %s" % st.get("turn"))

    # 3) actor 등록 확인
    if actor:
        step("행위자 '%s' 가 목록에 등록됨" % actor, actor in actors,
             "구글시트 설정 탭 '행위자목록' 끝에 ,%s 를 추가하세요(저장 즉시 적용)." % actor)
    # 4) project 확인 (경고 수준)
    if project:
        if project in projects:
            step("프로젝트 '%s' 가 목록에 등록됨" % project, True)
        else:
            print("  ! 프로젝트 '%s' 가 목록에 없음 — 설정 탭 '프로젝트목록' 확인(경고)" % project)

    # 5) 쓰기 왕복 (actor 등록돼 있을 때만)
    if actor and actor in actors and project in projects:
        res = "__preflight__"
        c1 = call(cfg, "claim", {"project": project, "resource": res, "actor": actor,
                                 "memo": "자가진단(무시)", "minutes": 1})
        wrote = isinstance(c1, dict) and c1.get("ok") is True
        step("쓰기 왕복: claim 성공", wrote, "쓰기 권한/파라미터 확인: " + str(c1.get("error")) if not wrote else "")
        if wrote:
            r1 = call(cfg, "release", {"project": project, "resource": res, "actor": actor})
            step("쓰기 왕복: release 성공(정리 완료)", isinstance(r1, dict) and r1.get("ok") is True)
    else:
        print("  · 쓰기 왕복은 actor·project 등록 후 다시 진단하세요(건너뜀).")

    print()
    if ok_all:
        print("✅ 가동 준비 완료 — 헤르메스에 스킬을 등록하고 `poll --watch` 로 상시 가동하세요.")
        sys.exit(0)
    else:
        print("✗ 아직 준비가 안 됐습니다. 위 → 항목을 고치고 다시 `doctor` 를 실행하세요.")
        sys.exit(1)


# ----------------------------------------------------------------------
# 인자 → 파라미터 매핑
# ----------------------------------------------------------------------
def with_defaults(cfg, args, need_actor=True, need_project=True):
    p = {}
    actor = getattr(args, "actor", None) or cfg.get("actor")
    project = getattr(args, "project", None) or cfg.get("project")
    if need_actor:
        if not actor:
            die("actor 가 필요합니다. --actor 또는 설정파일에 지정하세요.")
        p["actor"] = actor
    if need_project and project:
        p["project"] = project
    return p, actor, project


def main():
    # 공통 옵션 — 서브커맨드 앞/뒤 어디에 와도 먹도록 부모 파서로 둔다.
    # default=SUPPRESS: 주지 않으면 네임스페이스에 아예 안 생겨 서로 덮어쓰지 않음.
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--config", default=argparse.SUPPRESS, help="설정파일 경로 (기본: 스크립트 옆 gwanje.config.json)")
    common.add_argument("--actor", default=argparse.SUPPRESS, help="행위자 이름 (기본: 설정파일)")
    common.add_argument("--project", default=argparse.SUPPRESS, help="프로젝트 이름 (기본: 설정파일)")
    common.add_argument("--json", action="store_true", default=argparse.SUPPRESS, help="응답을 JSON 원문으로 출력")
    common.add_argument("--dry-run", dest="dry_run", action="store_true", default=argparse.SUPPRESS, help="호출하지 않고 만들 URL만 보여줌(토큰 가림)")

    ap = argparse.ArgumentParser(
        prog="gwanje_client.py", parents=[common],
        description="AI 협업 관제판 클라이언트 — 관제판을 명령어로 호출한다.")
    sub = ap.add_subparsers(dest="cmd", required=True, parser_class=lambda **kw: argparse.ArgumentParser(parents=[common], **kw))

    sub.add_parser("status", help="현재 잠금·차례·하는중 카드")

    sp = sub.add_parser("claim", help="자원 잠그기 (작업 시작 전)")
    sp.add_argument("resource"); sp.add_argument("--memo"); sp.add_argument("--minutes", type=int)

    sp = sub.add_parser("release", help="자원 놓기 (작업 끝)")
    sp.add_argument("resource")

    sp = sub.add_parser("heartbeat", help="잠금 연장 (30분마다)")
    sp.add_argument("resource"); sp.add_argument("--minutes", type=int)

    sp = sub.add_parser("card-add", help="카드 만들기")
    sp.add_argument("title"); sp.add_argument("--assignee"); sp.add_argument("--status")
    sp.add_argument("--priority"); sp.add_argument("--resource"); sp.add_argument("--memo")

    sp = sub.add_parser("card-move", help="카드 상태 옮기기 (할일/하는중/끝)")
    sp.add_argument("cardId"); sp.add_argument("status")

    sp = sub.add_parser("card-edit", help="카드 내용 수정")
    sp.add_argument("cardId"); sp.add_argument("--title"); sp.add_argument("--assignee")
    sp.add_argument("--priority"); sp.add_argument("--resource"); sp.add_argument("--memo")

    sub.add_parser("card-list", help="카드 목록")

    sp = sub.add_parser("turn", help="현재차례를 넘기기")
    sp.add_argument("to", help="차례를 받을 행위자")

    sp = sub.add_parser("log", help="한 줄 보고 남기기")
    sp.add_argument("text"); sp.add_argument("--target")

    sp = sub.add_parser("log-list", help="일지 최근 N줄")
    sp.add_argument("--limit", type=int, default=30)

    sub.add_parser("guide-list", help="지시문 목록")
    sp = sub.add_parser("guide-get", help="지시문 내용 보기"); sp.add_argument("title")
    sp = sub.add_parser("guide-save", help="지시문 저장(버전+1)")
    sp.add_argument("title"); sp.add_argument("content"); sp.add_argument("--tags")

    sub.add_parser("prompt", help="앱이 만들어주는 표준 에이전트 프롬프트")

    sp = sub.add_parser("discuss-add", help="토론 글/답글 올리기")
    sp.add_argument("topic"); sp.add_argument("text"); sp.add_argument("--parent")
    sp = sub.add_parser("discuss-list", help="토론 글 목록"); sp.add_argument("--topic")

    sub.add_parser("doctor", help="가동 준비 자가진단 (설정→연결→actor등록→쓰기왕복)")

    sp = sub.add_parser("poll", help="지금 나에게 필요한 것 요약 (--watch 로 상시 감시)")
    sp.add_argument("--watch", action="store_true"); sp.add_argument("--interval", type=int, default=20)

    sp = sub.add_parser("raw", help="임의 액션 직접 호출: raw <action> key=value ...")
    sp.add_argument("action"); sp.add_argument("kv", nargs="*")

    args = ap.parse_args()
    # SUPPRESS 로 빠졌을 수 있는 공통 옵션을 안전하게 확정
    args.config = getattr(args, "config", DEFAULT_CONFIG)
    args.json = getattr(args, "json", False)
    args.dry_run = getattr(args, "dry_run", False)
    if not hasattr(args, "actor"):
        args.actor = None
    if not hasattr(args, "project"):
        args.project = None
    cfg = load_config(args.config)

    # dry-run: URL만
    def maybe_dry(action, params):
        if args.dry_run:
            url = build_url(cfg, action, {k: v for k, v in params.items() if v is not None})
            print(mask_token(url, cfg.get("token")))
            sys.exit(0)

    c = args.cmd

    if c == "status":
        p, _, project = with_defaults(cfg, args, need_actor=False)
        maybe_dry("status", p); emit(call(cfg, "status", p), args.json)

    elif c == "claim":
        p, actor, _ = with_defaults(cfg, args)
        p.update(resource=args.resource, memo=args.memo, minutes=args.minutes)
        maybe_dry("claim", p); emit(call(cfg, "claim", p), args.json)

    elif c == "release":
        p, actor, _ = with_defaults(cfg, args)
        p["resource"] = args.resource
        maybe_dry("release", p); emit(call(cfg, "release", p), args.json)

    elif c == "heartbeat":
        p, actor, _ = with_defaults(cfg, args)
        p.update(resource=args.resource, minutes=args.minutes)
        maybe_dry("heartbeat", p); emit(call(cfg, "heartbeat", p), args.json)

    elif c == "card-add":
        p, actor, _ = with_defaults(cfg, args)
        p.update(title=args.title, assignee=args.assignee, status=args.status,
                 priority=args.priority, resource=args.resource, memo=args.memo)
        maybe_dry("card_add", p); emit(call(cfg, "card_add", p), args.json)

    elif c == "card-move":
        p, actor, _ = with_defaults(cfg, args, need_project=False)
        p.update(cardId=args.cardId, status=args.status)
        maybe_dry("card_move", p); emit(call(cfg, "card_move", p), args.json)

    elif c == "card-edit":
        p, actor, _ = with_defaults(cfg, args, need_project=False)
        p.update(cardId=args.cardId, title=args.title, assignee=args.assignee,
                 priority=args.priority, resource=args.resource, memo=args.memo)
        maybe_dry("card_edit", p); emit(call(cfg, "card_edit", p), args.json)

    elif c == "card-list":
        p, _, _ = with_defaults(cfg, args, need_actor=False)
        maybe_dry("card_list", p); emit(call(cfg, "card_list", p), args.json)

    elif c == "turn":
        p, _, _ = with_defaults(cfg, args, need_actor=False, need_project=False)
        p["actor"] = args.to
        by = args.actor or cfg.get("actor")
        if by:
            p["by"] = by
        maybe_dry("turn", p); emit(call(cfg, "turn", p), args.json)

    elif c == "log":
        p, actor, _ = with_defaults(cfg, args)
        p.update(text=args.text, target=args.target)
        maybe_dry("log", p); emit(call(cfg, "log", p), args.json)

    elif c == "log-list":
        p, _, _ = with_defaults(cfg, args, need_actor=False)
        p["limit"] = args.limit
        maybe_dry("log_list", p); emit(call(cfg, "log_list", p), args.json)

    elif c == "guide-list":
        p, _, _ = with_defaults(cfg, args, need_actor=False)
        maybe_dry("guide_list", p); emit(call(cfg, "guide_list", p), args.json)

    elif c == "guide-get":
        p, _, _ = with_defaults(cfg, args, need_actor=False)
        p["title"] = args.title
        maybe_dry("guide_get", p); emit(call(cfg, "guide_get", p), args.json)

    elif c == "guide-save":
        p, actor, _ = with_defaults(cfg, args)
        p.update(title=args.title, content=args.content, tags=args.tags)
        maybe_dry("guide_save", p); emit(call(cfg, "guide_save", p), args.json)

    elif c == "prompt":
        p, actor, _ = with_defaults(cfg, args)
        maybe_dry("prompt", p); emit(call(cfg, "prompt", p), args.json)

    elif c == "discuss-add":
        p, actor, _ = with_defaults(cfg, args)
        p.update(topic=args.topic, text=args.text, parent=args.parent)
        maybe_dry("discuss_add", p); emit(call(cfg, "discuss_add", p), args.json)

    elif c == "discuss-list":
        p, _, _ = with_defaults(cfg, args, need_actor=False)
        p["topic"] = args.topic
        maybe_dry("discuss_list", p); emit(call(cfg, "discuss_list", p), args.json)

    elif c == "doctor":
        do_doctor(cfg, args)

    elif c == "poll":
        do_poll(cfg, args)

    elif c == "raw":
        params = {}
        for kv in args.kv:
            if "=" not in kv:
                die("raw 인자는 key=value 형식이어야 합니다: " + kv)
            k, v = kv.split("=", 1)
            params[k] = v
        maybe_dry(args.action, params); emit(call(cfg, args.action, params), args.json)


if __name__ == "__main__":
    main()
