#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
관제판 설치 점검 — 기계로 판정되는 것만 한 번에 확인한다. 아무것도 바꾸지 않는다.

  실행:  python tools/점검.py          (윈도우는 tools\점검.ps1, 맥·리눅스는 tools/점검.sh 로도 됨)

권한 동의 화면처럼 사람이 눌러야 하는 구간은 여기서 확인할 수 없다. 그건 문서의 몫이다.
여기서 잡는 것: 준비물 유무 · 설정값(자리표시자 포함) · 앱 연결 · 버전 최신 여부 ·
이름 맞춤(unknown_actor 사고 예방) · 스크립트 파일 인코딩.
"""
import io, json, os, re, shutil, subprocess, sys, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 윈도우 콘솔 기본 인코딩(CP949)에서는 ✓ ↷ 같은 기호가 UnicodeEncodeError 를 낸다.
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')   # 파이썬 3.7+
except Exception:
    pass
# 색은 진짜 터미널에서만. 파일로 넘기거나 옛 윈도우 콘솔에서는 색 코드가 글자로 보인다.
if sys.stdout.isatty() and os.name != 'nt':
    G, Y, R, Z = '\033[32m', '\033[33m', '\033[31m', '\033[0m'
else:
    G = Y = R = Z = ''

PASS, WARN, BAD = [], [], []
def ok(m):   PASS.append(m); print("  %s✓%s %s" % (G, Z, m))
def warn(m, hint=""):
    WARN.append(m); print("  %s↷%s %s" % (Y, Z, m))
    if hint: print("      → " + hint)
def bad(m, hint=""):
    BAD.append(m); print("  %s✗%s %s" % (R, Z, m))
    if hint: print("      → " + hint)
def head(m): print("\n" + m)

# 자리표시자로 흔히 남는 값들 (실제로 그대로 둔 채 실행한 적이 있다)
PLACEHOLDER = re.compile(r'여기에|<.*>|\.\.\.|…|YOUR_|xxx', re.I)

def load_json(path):
    with io.open(path, encoding='utf-8') as f:
        return json.load(f)

def check_value(label, value, where):
    v = (value or '').strip()
    if not v:
        bad("%s — 비어 있습니다" % label, "%s 를 채우세요" % where); return None
    if PLACEHOLDER.search(v):
        bad("%s — 자리표시자가 그대로입니다 (%r)" % (label, v[:30]),
            "%s 에 실제 값을 넣으세요" % where); return None
    return v

# ---------------------------------------------------------------- 1. 준비물
head("[1] 준비물")
print("  · 파이썬 %s" % sys.version.split()[0])
clis = {}
for cmd, name in (('claude', '클로드코드'), ('codex', '코덱스'), ('hermes', '헤르메스')):
    found = shutil.which(cmd) is not None
    clis[cmd] = found
    if found: ok("%s (%s) 있음" % (name, cmd))
    else:     warn("%s (%s) 없음 — 자동토론에서 자동으로 빠집니다" % (name, cmd))
if sum(clis.values()) < 2:
    warn("쓸 수 있는 CLI가 %d 개입니다 — 자동토론에는 둘 이상을 권합니다" % sum(clis.values()),
         "작업보드만 쓰실 거라면 문제 없습니다")

# ---------------------------------------------------------------- 2. 설정 파일
head("[2] 설정 파일")
CLIENT = os.path.join(ROOT, 'client', 'gwanje.config.json')
DEBATE = os.path.join(ROOT, 'discuss', '자동토론.config.json')
url = token = None
cli_cfg = deb_cfg = None

if os.path.exists(CLIENT):
    try:
        cli_cfg = load_json(CLIENT)
        url   = check_value("client/gwanje.config.json 의 url",   cli_cfg.get('url'),   "배포한 웹앱 주소(…/exec)")
        token = check_value("client/gwanje.config.json 의 token", cli_cfg.get('token'), "구글시트 설정 탭의 24자리 토큰")
        if url and token: ok("client/gwanje.config.json — url·token 채워짐")
    except Exception as e:
        bad("client/gwanje.config.json — JSON 형식 오류: %s" % e, "쉼표·따옴표를 확인하세요")
else:
    warn("client/gwanje.config.json 없음", "같은 폴더의 gwanje.config.example.json 을 복사해 만드세요")

if os.path.exists(DEBATE):
    try:
        deb_cfg = load_json(DEBATE)
        g = deb_cfg.get('관제판', {}) or {}
        du = check_value("discuss/자동토론.config.json 의 url",   g.get('url'),   "배포한 웹앱 주소")
        dt = check_value("discuss/자동토론.config.json 의 token", g.get('token'), "구글시트 설정 탭의 토큰")
        if du and dt:
            ok("discuss/자동토론.config.json — url·token 채워짐")
            if url and token and (du != url or dt != token):
                warn("두 설정 파일의 주소·토큰이 서로 다릅니다", "다른 보드를 가리키는 게 의도인지 확인하세요")
        url = url or du; token = token or dt
    except Exception as e:
        bad("discuss/자동토론.config.json — JSON 형식 오류: %s" % e)
else:
    warn("discuss/자동토론.config.json 없음 (자동토론 쓸 때만 필요)",
         "자동토론.config.example.json 을 복사해 만드세요")

# ---------------------------------------------------------------- 3. 관제판 연결
def api(action, params=None):
    q = {'token': token, 'action': action}
    q.update(params or {})
    req = urllib.request.Request(url + '?' + urllib.parse.urlencode(q))
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode('utf-8'))

head("[3] 관제판 연결")
state = None
if not (url and token):
    warn("주소·토큰이 준비되면 여기서 연결까지 확인합니다")
else:
    try:
        state = api('status')
    except Exception as e:
        bad("앱에 연결하지 못했습니다: %s" % e,
            "주소가 …/exec 로 끝나는지, 인터넷이 되는지 확인하세요")
    if state is not None:
        if not state.get('ok'):
            bad("앱이 거부했습니다: %s" % state.get('error'),
                "토큰이 틀렸습니다. 시트 설정 탭의 값과 맞춰 보세요" if state.get('error') == 'unauthorized' else "")
            state = None
        else:
            appver = state.get('version')
            if appver:
                ok("응답 정상 — 이 보드의 앱 버전 v%s" % appver)
                ch = os.path.join(ROOT, 'CHANGELOG.md')
                if os.path.exists(ch):
                    m = re.search(r'^##\s*([0-9]+\.[0-9]+)', io.open(ch, encoding='utf-8').read(), re.M)
                    if m and m.group(1) != appver:
                        warn("최신은 %s 입니다 — 이 보드는 v%s" % (m.group(1), appver),
                             "docs/1_설치_10분.md 의 '내 버전 확인하고 올리기' 참고. 데이터는 안 없어집니다")
                    elif m:
                        ok("최신입니다 (CHANGELOG %s)" % m.group(1))
            else:
                warn("응답은 정상인데 버전이 없습니다 — 이 보드는 v1.1 이하입니다",
                     "docs/1_설치_10분.md 의 '내 버전 확인하고 올리기' 참고")

# ---------------------------------------------------------------- 4. 이름 맞춤
head("[4] 이름 맞춤 (시트 설정 탭과 맞는가)")
if state is None:
    warn("연결이 돼야 확인할 수 있습니다")
else:
    actors   = state.get('actors', [])
    projects = state.get('projects', [])
    print("  · 시트에 등록된 행위자: %s" % ', '.join(actors))
    print("  · 시트에 등록된 프로젝트: %s" % ', '.join(projects))
    if cli_cfg:
        a = (cli_cfg.get('actor') or '').strip()
        if not a: warn("client 설정에 actor 가 비었습니다")
        elif a in actors: ok("client 의 actor '%s' 등록됨" % a)
        else: bad("client 의 actor '%s' 가 행위자목록에 없습니다" % a,
                  "시트 설정 탭 행위자목록에 '%s' 를 추가하세요 (없으면 unknown_actor 로 거부됩니다)" % a)
    if deb_cfg:
        proj = ((deb_cfg.get('관제판') or {}).get('project') or '').strip()
        if proj and proj not in projects:
            bad("자동토론의 project '%s' 가 프로젝트목록에 없습니다" % proj,
                "시트 설정 탭 프로젝트목록에 '%s' 를 추가하세요" % proj)
        elif proj: ok("자동토론의 project '%s' 등록됨" % proj)
        for p in (deb_cfg.get('참가자') or []):
            if p.get('사용') is False or not p.get('cli'): continue
            nm = (p.get('이름') or '').strip()
            if not nm: continue
            if nm in actors: ok("참가자 '%s' 등록됨" % nm)
            else: bad("참가자 '%s' 가 행위자목록에 없습니다" % nm,
                      "시트 설정 탭 행위자목록에 '%s' 를 추가하세요. 없으면 그 참가자 글이 전부 거부됩니다" % nm)

# ---------------------------------------------------------------- 5. 스크립트 파일
head("[5] 스크립트 파일 (윈도우 한글 깨짐 예방)")
ps1 = os.path.join(ROOT, 'discuss', '자동토론_드라이버.ps1')
sh  = os.path.join(ROOT, 'discuss', '자동토론_드라이버.sh')
if os.path.exists(ps1):
    raw = io.open(ps1, 'rb').read()
    if raw.startswith(b'\xef\xbb\xbf'): ok("드라이버 .ps1 — UTF-8 BOM 있음")
    else: bad("드라이버 .ps1 에 UTF-8 BOM 이 없습니다",
              "윈도우 PowerShell 이 한글을 깨뜨립니다. 저장소에서 파일을 다시 받으세요")
if os.path.exists(sh):
    if b'\r' in io.open(sh, 'rb').read():
        bad("드라이버 .sh 에 CR(윈도우 줄바꿈)이 섞였습니다", "저장소에서 파일을 다시 받으세요")
    else: ok("드라이버 .sh — 줄바꿈 정상")

# ---------------------------------------------------------------- 요약
print("\n" + "─" * 46)
print("통과 %d · 경고 %d · 문제 %d" % (len(PASS), len(WARN), len(BAD)))
if BAD:
    print("\n%s✗%s 위의 ✗ 를 먼저 해결하세요. 그 상태로는 제대로 안 돕니다." % (R, Z))
elif WARN:
    print("\n%s↷%s 쓸 수 있습니다. ↷ 는 안 쓰는 기능이면 무시해도 됩니다." % (Y, Z))
else:
    print("\n%s✓%s 이상 없습니다." % (G, Z))
sys.exit(1 if BAD else 0)
