/**
 * ============================================================
 *  AI 협업 관제판 v2 — 백엔드 (Google Apps Script)
 * ============================================================
 *
 *  Copyright (c) 2026 오영진
 *  MIT License — 이 표시를 지우지 마세요. 전문:
 *  https://github.com/jinstudy2024-ai/gwanje-board/blob/main/LICENSE
 *
 *  ■ 무엇인가
 *    여러 AI 도구(클로드코드·코덱스 등)와 사람이 같은 프로젝트를 병행할 때
 *    "지금 누가 무엇을 잡고 있는지"를 한 곳에 두는 교통 신호등.
 *    파일 내용·병합·되돌리기는 하지 않는다(그건 Git). 조율만 한다.
 *
 *  ■ 구조
 *    - DB      = 이 스크립트가 바인딩된 구글 스프레드시트 (탭 = 테이블)
 *    - 웹주소  = doGet(...)  → ?token=…&action=…  → JSON 응답 (AI 도구용)
 *    - 화면    = Index.html  → google.script.run.rpc(token, action, params)
 *                화면도 같은 route_() 를 탄다. 로직 중복 없음.
 *
 *  ■ 절대 규칙
 *    - 모델 API·API 키 없음. 이 코드가 여는 주소는 오직 "우리 앱" 뿐.
 *    - 일지·지시문 행은 삭제하지 않는다(감사 추적).
 *    - 모든 호출은 token 필수. 틀리면 {ok:false,error:"unauthorized"}.
 *
 *  ■ 비개발자 유지보수 포인트
 *    - 행위자·프로젝트·기본만료분·현재차례·토큰은 코드가 아니라 "설정" 탭에서 고친다.
 *    - 처음 한 번만 setupSheets() 를 실행하면 탭이 자동 생성된다.
 *    - 예시 데이터를 보고 싶으면 seedExampleData() 를 한 번 실행한다.
 * ============================================================
 */

// ---------- 시간대 ----------
var TZ = 'Asia/Seoul';

// ---------- 탭 이름 ----------
// ---------- 앱 버전 ----------
// 이 값은 "코드와 함께 사본으로 따라가는" 버전 표시다. 사본을 받은 사람은 화면 오른쪽 위에서
// 자기 버전을 확인하고, 저장소의 CHANGELOG.md 와 비교해 최신인지 알 수 있다.
// ⚠ 코드를 고쳐 배포할 때마다 이 값과 CHANGELOG.md 를 같이 올릴 것. (test/run_tests.js 가 일치를 검사한다)
var APP_VERSION = '1.2';

var SHEET_CFG   = '설정';
var SHEET_LOCK  = '잠금';
var SHEET_BOARD = '보드';
var SHEET_LOG   = '일지';
var SHEET_GUIDE = '지시문';
var SHEET_DISCUSS = '토론';

// ---------- 각 탭의 헤더(1행). 순서 = 열 순서 ----------
var CFG_HEADERS   = ['키', '값'];
var LOCK_HEADERS  = ['잠금ID', '프로젝트', '자원', '행위자', '상태', '잡은시각', '만료시각', '메모'];
var BOARD_HEADERS = ['카드ID', '프로젝트', '제목', '담당', '상태', '우선순위', '관련자원', '메모', '생성시각', '수정시각'];
var LOG_HEADERS   = ['일시', '프로젝트', '행위자', '행동', '대상', '상세'];
var GUIDE_HEADERS = ['지시문ID', '프로젝트', '제목', '내용', '태그', '버전', '갱신일'];
var DISCUSS_HEADERS = ['글ID', '프로젝트', '주제', '작성자', '내용', '부모글ID', '시각'];

// ---------- 상태 값 ----------
var LOCK_ACTIVE   = '작업중';
var LOCK_RELEASED = '해제';
var LOCK_EXPIRED  = '만료';

var CARD_TODO  = '할일';
var CARD_DOING = '하는중';
var CARD_DONE  = '끝';
var CARD_STATUSES = [CARD_TODO, CARD_DOING, CARD_DONE];
var PRIORITIES    = ['높음', '보통', '낮음'];

// 사람(강제 해제 권한). 설정 탭 행위자목록에도 반드시 들어 있어야 한다.
var HUMAN = '나';

// ---------- 설정 탭 초기값 (토큰은 setup 때 무작위 생성) ----------
var DEFAULT_CFG = {
  '행위자목록': '나,클로드,ChatGPT,헤르메스',
  '프로젝트목록': '내프로젝트,연습',
  '기본만료분': '120',
  '현재차례': '나'
};


// ============================================================
// 0. 공통 유틸
// ============================================================

/** 이 스크립트에 바인딩된 스프레드시트 */
function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

/** 탭 가져오기. 없으면 예외 (setupSheets 먼저 실행하라는 뜻) */
function sheet_(name) {
  var s = ss_().getSheetByName(name);
  if (!s) throw new Error('탭 "' + name + '" 이 없습니다. setupSheets() 를 먼저 실행하세요.');
  return s;
}

/** 지금 시각. 테스트에서 바꿔 끼울 수 있게 함수로 분리 */
function now_() { return new Date(); }

/** 문자열 정리: 없으면 '' , 앞뒤 공백 제거, 대소문자는 그대로 */
function str_(v) { return (v === undefined || v === null) ? '' : String(v).trim(); }

/** 숫자 변환. 실패하면 기본값 */
function num_(v, dflt) {
  var n = Number(v);
  return (v === undefined || v === null || v === '' || isNaN(n)) ? dflt : n;
}

/** 쉼표 목록 → 배열 (빈 항목 제거) */
function split_(s) {
  return str_(s).split(',').map(function (x) { return x.trim(); }).filter(function (x) { return x; });
}

/** 셀 값 → Date (이미 Date면 그대로, 문자열이면 파싱). 실패하면 null */
function toDate_(v) {
  if (v === undefined || v === null || v === '') return null;
  if (Object.prototype.toString.call(v) === '[object Date]') return isNaN(v.getTime()) ? null : v;
  var d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

/** 표시용 시각 문자열 */
function fmt_(v) {
  var d = toDate_(v);
  return d ? Utilities.formatDate(d, TZ, 'yyyy-MM-dd HH:mm') : '';
}

/** 짧은 ID (UUID 앞 8자) */
function shortId_() { return Utilities.getUuid().replace(/-/g, '').slice(0, 8); }

/** 무작위 토큰 24자 (16진수) — 모델 API 키가 아니라 "우리 앱 문 여는 열쇠" */
function makeToken_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').slice(0, 24);
}

/**
 * 탭 전체 읽기 → { headers, rows }
 * rows[i] = { 헤더명: 값, ..., _row: 시트 행번호(1부터) }
 */
function readTable_(name) {
  var s = sheet_(name);
  var values = s.getDataRange().getValues();
  var headers = values.length ? values[0].map(String) : [];
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var r = values[i];
    if (r.join('') === '') continue; // 완전 빈 줄 건너뜀
    var o = { _row: i + 1 };
    for (var j = 0; j < headers.length; j++) o[headers[j]] = (r[j] === undefined) ? '' : r[j];
    rows.push(o);
  }
  return { headers: headers, rows: rows };
}

/** 특정 행의 특정 열(헤더명) 값 바꾸기 */
function setCell_(name, headers, row, headerName, value) {
  var col = headers.indexOf(headerName);
  if (col < 0) throw new Error('헤더 "' + headerName + '" 없음 (' + name + ')');
  sheet_(name).getRange(row, col + 1).setValue(value);
}

/** 설정 탭 읽기 → { 키: 값(문자열) }. 한 실행 안에서는 캐시(요청마다 새 실행이라 안전) */
var cfgCache_ = null;
function readCfg_() {
  if (cfgCache_) return cfgCache_;
  var t = readTable_(SHEET_CFG);
  var cfg = {};
  t.rows.forEach(function (r) { cfg[str_(r['키'])] = str_(r['값']); });
  cfgCache_ = cfg;
  return cfg;
}

/** 설정 탭 쓰기 (있으면 갱신, 없으면 추가) */
function writeCfg_(key, value) {
  cfgCache_ = null;
  var t = readTable_(SHEET_CFG);
  for (var i = 0; i < t.rows.length; i++) {
    if (str_(t.rows[i]['키']) === key) { setCell_(SHEET_CFG, t.headers, t.rows[i]._row, '값', value); return; }
  }
  sheet_(SHEET_CFG).appendRow([key, value]);
}

/** 일지 한 줄 추가 (append 전용, 절대 지우지 않음) */
function log_(project, actor, action, target, detail) {
  sheet_(SHEET_LOG).appendRow([now_(), str_(project), str_(actor), str_(action), str_(target), str_(detail)]);
}

/** 토큰 검사 */
function checkToken_(token) {
  var t = str_(token);
  if (!t) return false;
  var cfg = readCfg_();
  var real = str_(cfg['토큰']);
  return !!real && t === real;
}

/** 필수 파라미터 검사 → 없으면 오류 객체, 다 있으면 null */
function require_(p, names) {
  var missing = names.filter(function (n) { return !str_(p[n]); });
  return missing.length ? { ok: false, error: 'missing_param', missing: missing } : null;
}

/** 행위자·프로젝트가 설정 탭 목록에 있는지 검사 → 문제 있으면 오류 객체 */
function validate_(cfg, p, checkActor, checkProject) {
  if (checkActor) {
    var actors = split_(cfg['행위자목록']);
    if (actors.indexOf(str_(p.actor)) < 0) return { ok: false, error: 'unknown_actor', actor: str_(p.actor), actors: actors };
  }
  if (checkProject) {
    var projects = split_(cfg['프로젝트목록']);
    if (projects.indexOf(str_(p.project)) < 0) return { ok: false, error: 'unknown_project', project: str_(p.project), projects: projects };
  }
  return null;
}


// ============================================================
// 1. 시트 초기화 · 예시 데이터
// ============================================================

/**
 * 탭 6개 자동 생성. 이미 있으면 건너뜀. 토큰 없으면 생성.
 * 편집기에서 한 번 실행 → 실행 로그에 토큰이 찍힌다.
 */
function setupSheets() {
  cfgCache_ = null;
  var ss = ss_();
  var created = [];
  var plan = [
    [SHEET_CFG, CFG_HEADERS], [SHEET_LOCK, LOCK_HEADERS], [SHEET_BOARD, BOARD_HEADERS],
    [SHEET_LOG, LOG_HEADERS], [SHEET_GUIDE, GUIDE_HEADERS], [SHEET_DISCUSS, DISCUSS_HEADERS]
  ];
  plan.forEach(function (pair) {
    var name = pair[0], headers = pair[1];
    if (ss.getSheetByName(name)) return;
    var s = ss.insertSheet(name);
    s.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    s.setFrozenRows(1);
    created.push(name);
  });

  // 설정 기본값 채우기 (있는 키는 건드리지 않음)
  var cfg = readCfg_();
  Object.keys(DEFAULT_CFG).forEach(function (k) {
    if (!cfg[k]) writeCfg_(k, DEFAULT_CFG[k]);
  });
  var tokenCreated = false;
  if (!cfg['토큰']) { writeCfg_('토큰', makeToken_()); tokenCreated = true; }
  var token = readCfg_()['토큰'];

  var msg = '생성된 탭: ' + (created.length ? created.join(', ') : '(없음 — 이미 있음)') +
            ' / 토큰: ' + token + (tokenCreated ? ' (새로 생성)' : ' (기존 유지)');
  Logger.log(msg);
  return { ok: true, created: created, token: token, tokenCreated: tokenCreated };
}

/**
 * 예시 데이터: 프로젝트 2개(내프로젝트·연습), 자원 3개(1개 잠긴 상태), 카드 4장, 지시문 1개.
 * 잠금·보드에 이미 데이터가 있으면 건너뜀(중복 방지).
 */
function seedExampleData() {
  setupSheets();
  if (readTable_(SHEET_LOCK).rows.length || readTable_(SHEET_BOARD).rows.length || readTable_(SHEET_GUIDE).rows.length) {
    Logger.log('이미 데이터가 있어 예시 데이터를 넣지 않았습니다.');
    return { ok: false, error: 'not_empty' };
  }
  var now = now_();
  var h = function (hours) { return new Date(now.getTime() + hours * 3600000); };

  // 잠금 3개: 1개 작업중(클로드), 1개 해제, 1개 만료
  var lockSheet = sheet_(SHEET_LOCK);
  lockSheet.appendRow(['L-' + shortId_(), '내프로젝트', 'Code.gs', '클로드', LOCK_ACTIVE, now, h(2), '로트 등록 함수 수정 중']);
  lockSheet.appendRow(['L-' + shortId_(), '내프로젝트', 'Index.html', 'ChatGPT', LOCK_RELEASED, h(-5), h(-3), '화면 폰 대응 (완료)']);
  lockSheet.appendRow(['L-' + shortId_(), '연습', '설치가이드.md', 'ChatGPT', LOCK_EXPIRED, h(-30), h(-28), '초안 작성 (잊힌 잠금 → 자동 만료)']);

  // 카드 4장
  var cards = [
    ['내프로젝트', '로트 등록 화면 수정', '클로드', CARD_DOING, '높음', 'Code.gs', '사진 첨부 오류 잡기'],
    ['내프로젝트', '설치가이드 갱신', 'ChatGPT', CARD_TODO, '보통', '설치가이드.md', '배포 순서 스크린샷 없이 글로만'],
    ['연습', '신호등 화면 QA', '나', CARD_TODO, '낮음', 'Index.html', '폰에서 잡기/놓기 눌러보기'],
    ['연습', '시트 초기 설정', 'ChatGPT', CARD_DONE, '보통', '설정탭', 'setupSheets 1회 완료']
  ];
  var boardSheet = sheet_(SHEET_BOARD);
  cards.forEach(function (c) {
    boardSheet.appendRow(['C-' + shortId_(), c[0], c[1], c[2], c[3], c[4], c[5], c[6], h(-1), h(-1)]);
  });

  // 지시문 1개
  sheet_(SHEET_GUIDE).appendRow([
    'G-' + shortId_(), '연습', '협업 규칙',
    '파일을 고치기 전에 반드시 status → claim. locked 이면 손대지 말 것. 끝나면 release + card_move 끝.',
    '규칙,공통', 1, now
  ]);

  // 일지
  log_('내프로젝트', '클로드', 'claim', 'Code.gs', '예시 데이터 · 120분');
  log_('내프로젝트', 'ChatGPT', 'release', 'Index.html', '예시 데이터');
  log_('연습', '시스템', 'expire', '설치가이드.md', '예시 데이터 · 만료 처리');
  log_('연습', 'ChatGPT', 'card_add', '시트 초기 설정', '예시 데이터');
  log_('연습', 'ChatGPT', 'guide_add', '협업 규칙', '예시 데이터 · v1');

  Logger.log('예시 데이터 입력 완료: 잠금 3, 카드 4, 지시문 1');
  return { ok: true, locks: 3, cards: 4, guides: 1 };
}


// ============================================================
// 2. 웹주소 진입점 (doGet) · 화면용 진입점 (rpc) · 라우터
// ============================================================

/**
 * AI 도구용 웹주소.  …/exec?token=…&action=…&project=…
 *  - action 없음 + 토큰 맞음 → 사람용 화면(Index.html)
 *  - action 있음            → JSON
 * ※ ContentService 응답은 302 리다이렉트 → curl 은 -L 옵션 필요
 */
function doGet(e) {
  var p = (e && e.parameter) ? e.parameter : {};
  cfgCache_ = null;
  if (!str_(p.action)) {
    var authed = false;
    try { authed = checkToken_(p.token); } catch (err) {
      return HtmlService.createHtmlOutput('<p style="font-family:sans-serif;padding:24px">아직 준비가 안 됐습니다: ' + String(err && err.message ? err.message : err) + '</p>');
    }
    if (!authed) {
      return HtmlService.createHtmlOutput(
        '<p style="font-family:sans-serif;padding:24px">unauthorized — 주소 뒤에 <b>?token=…</b> 을 붙여 여세요. (토큰은 시트의 "설정" 탭)</p>'
      );
    }
    var t = HtmlService.createTemplateFromFile('Index');
    t.token = str_(p.token);
    return t.evaluate()
      .setTitle('AI 협업 관제판')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  var out = route_(p);
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/** 화면(Index.html)용. google.script.run.rpc(token, action, params) — 같은 라우터를 탄다 */
function rpc(token, action, params) {
  var p = {};
  var src = params || {};
  Object.keys(src).forEach(function (k) { p[k] = src[k]; });
  p.token = token;
  p.action = action;
  return route_(p);
}

/** 라우터: 토큰 검사 → action 분기. 동시 요청 대비 LockService */
function route_(p) {
  cfgCache_ = null;
  try {
    if (!checkToken_(p.token)) return { ok: false, error: 'unauthorized' };
    var action = str_(p.action);
    var handlers = {
      status: getState,
      claim: claim,
      release: release,
      heartbeat: heartbeat,
      card_add: addCard,
      card_move: moveCard,
      card_edit: editCard,
      card_list: listCards,
      turn: passTurn,
      log: addNote,
      log_list: listLog,
      guide_get: getGuide,
      guide_list: listGuides,
      guide_save: saveGuide,
      prompt: agentPrompt,
      discuss_add: discussAdd,
      discuss_list: discussList,
      version: getVersion
    };
    var fn = handlers[action];
    if (!fn) return { ok: false, error: 'unknown_action', action: action, actions: Object.keys(handlers) };
    var lock = LockService.getScriptLock();
    lock.waitLock(15000);
    try { return fn(p); } finally { lock.releaseLock(); }
  } catch (err) {
    return { ok: false, error: 'exception', detail: String(err && err.message ? err.message : err) };
  }
}


// ============================================================
// 3. 신호등(잠금) — status / claim / release / heartbeat / expire
// ============================================================

/**
 * 만료된 작업중 잠금 → '만료' 처리 + 일지 expire.
 * 반환: 처리 후 잠금 테이블(메모리에서도 상태 갱신). activeLocks_(t) 에 넘기면 시트를 다시 읽지 않는다
 */
function expireStale_() {
  var t = readTable_(SHEET_LOCK);
  var now = now_();
  t.expired = 0;
  t.rows.forEach(function (r) {
    if (str_(r['상태']) !== LOCK_ACTIVE) return;
    var until = toDate_(r['만료시각']);
    if (until && until.getTime() > now.getTime()) return;
    setCell_(SHEET_LOCK, t.headers, r._row, '상태', LOCK_EXPIRED);
    r['상태'] = LOCK_EXPIRED;
    log_(r['프로젝트'], '시스템', 'expire', r['자원'], '만료 자동 처리 (원래 ' + str_(r['행위자']) + ' · ' + fmt_(until) + ')');
    t.expired++;
  });
  return t;
}

/** 유효 잠금 목록 (작업중 & 만료 전). table 을 주면 재사용, 없으면 시트에서 읽음 */
function activeLocks_(table) {
  var t = table || readTable_(SHEET_LOCK);
  var now = now_();
  var out = [];
  t.rows.forEach(function (r) {
    if (str_(r['상태']) !== LOCK_ACTIVE) return;
    var until = toDate_(r['만료시각']);
    if (!until || until.getTime() <= now.getTime()) return;
    r._headers = t.headers;
    out.push(r);
  });
  return out;
}

/** 같은 프로젝트·같은 자원의 유효 잠금 1개 (없으면 null) */
function findActiveLock_(project, resource, table) {
  var list = activeLocks_(table);
  for (var i = 0; i < list.length; i++) {
    if (str_(list[i]['프로젝트']) === project && str_(list[i]['자원']) === resource) return list[i];
  }
  return null;
}

/** 잠금 행 → 응답용 객체 */
function lockOut_(r) {
  var until = toDate_(r['만료시각']);
  var left = until ? Math.max(0, Math.round((until.getTime() - now_().getTime()) / 60000)) : 0;
  return {
    id: str_(r['잠금ID']), project: str_(r['프로젝트']), resource: str_(r['자원']), actor: str_(r['행위자']),
    since: fmt_(r['잡은시각']), until: fmt_(r['만료시각']), minutesLeft: left, memo: str_(r['메모'])
  };
}

/** action=status — 현재차례 · 유효 잠금 · 하는중 카드 · 설정 목록 */
function getState(p) {
  var lockTable = expireStale_();
  var project = str_(p.project);
  var cfg = readCfg_();
  var locks = activeLocks_(lockTable)
    .filter(function (r) { return !project || str_(r['프로젝트']) === project; })
    .map(lockOut_);
  var doing = readTable_(SHEET_BOARD).rows
    .filter(function (c) { return str_(c['상태']) === CARD_DOING && (!project || str_(c['프로젝트']) === project); })
    .map(cardOut_);
  return {
    ok: true,
    version: APP_VERSION,
    now: fmt_(now_()),
    project: project || '(전체)',
    turn: str_(cfg['현재차례']),
    locks: locks,
    doing: doing,
    actors: split_(cfg['행위자목록']),
    projects: split_(cfg['프로젝트목록']),
    defaultMinutes: num_(cfg['기본만료분'], 120)
  };
}

/** action=version — 이 사본이 몇 버전인지. 데이터를 건드리지 않는다 */
function getVersion(p) {
  return { ok: true, version: APP_VERSION };
}

/** action=claim — 자원 잠그기. 남이 잡고 있으면 거부(locked). 본인이 다시 잡으면 연장 */
function claim(p) {
  var miss = require_(p, ['project', 'resource', 'actor']); if (miss) return miss;
  var cfg = readCfg_();
  var bad = validate_(cfg, p, true, true); if (bad) return bad;
  var lockTable = expireStale_();

  var project = str_(p.project), resource = str_(p.resource), actor = str_(p.actor), memo = str_(p.memo);
  var minutes = num_(p.minutes, num_(cfg['기본만료분'], 120));
  if (minutes <= 0) minutes = num_(cfg['기본만료분'], 120);
  var now = now_();
  var until = new Date(now.getTime() + minutes * 60000);

  var existing = findActiveLock_(project, resource, lockTable);
  if (existing) {
    if (str_(existing['행위자']) === actor) {
      setCell_(SHEET_LOCK, existing._headers, existing._row, '만료시각', until);
      if (memo) setCell_(SHEET_LOCK, existing._headers, existing._row, '메모', memo);
      log_(project, actor, 'heartbeat', resource, '재잡기 → ' + fmt_(until) + '까지');
      return { ok: true, renewed: true, lockId: str_(existing['잠금ID']), resource: resource, actor: actor, until: fmt_(until), minutes: minutes };
    }
    return {
      ok: false, error: 'locked', resource: resource,
      by: str_(existing['행위자']), until: fmt_(existing['만료시각']), memo: str_(existing['메모'])
    };
  }

  var id = 'L-' + shortId_();
  sheet_(SHEET_LOCK).appendRow([id, project, resource, actor, LOCK_ACTIVE, now, until, memo]);
  log_(project, actor, 'claim', resource, minutes + '분 · ' + fmt_(until) + '까지' + (memo ? ' · ' + memo : ''));
  return { ok: true, lockId: id, project: project, resource: resource, actor: actor, until: fmt_(until), minutes: minutes };
}

/** action=release — 잠금 해제. 잡은 본인 또는 '나'(강제) */
function release(p) {
  var miss = require_(p, ['project', 'resource', 'actor']); if (miss) return miss;
  var cfg = readCfg_();
  var bad = validate_(cfg, p, true, false); if (bad) return bad;
  var lockTable = expireStale_();

  var project = str_(p.project), resource = str_(p.resource), actor = str_(p.actor);
  var existing = findActiveLock_(project, resource, lockTable);
  if (!existing) return { ok: false, error: 'not_locked', resource: resource };

  var owner = str_(existing['행위자']);
  var force = owner !== actor;
  if (force && actor !== HUMAN) return { ok: false, error: 'forbidden', resource: resource, by: owner };

  setCell_(SHEET_LOCK, existing._headers, existing._row, '상태', LOCK_RELEASED);
  log_(project, actor, 'release', resource, force ? 'force (원래 ' + owner + ')' : '정상 해제');
  return { ok: true, released: true, resource: resource, force: force, by: owner };
}

/** action=heartbeat — 만료시각 연장 (잡은 본인만) */
function heartbeat(p) {
  var miss = require_(p, ['project', 'resource', 'actor']); if (miss) return miss;
  var cfg = readCfg_();
  var bad = validate_(cfg, p, true, false); if (bad) return bad;
  var lockTable = expireStale_();

  var project = str_(p.project), resource = str_(p.resource), actor = str_(p.actor);
  var existing = findActiveLock_(project, resource, lockTable);
  if (!existing) return { ok: false, error: 'not_locked', resource: resource };
  var owner = str_(existing['행위자']);
  if (owner !== actor) return { ok: false, error: 'forbidden', resource: resource, by: owner };

  var minutes = num_(p.minutes, num_(cfg['기본만료분'], 120));
  if (minutes <= 0) minutes = num_(cfg['기본만료분'], 120);
  var until = new Date(now_().getTime() + minutes * 60000);
  setCell_(SHEET_LOCK, existing._headers, existing._row, '만료시각', until);
  log_(project, actor, 'heartbeat', resource, '연장 → ' + fmt_(until) + '까지');
  return { ok: true, resource: resource, actor: actor, until: fmt_(until), minutes: minutes };
}


// ============================================================
// 4. 작업보드 — card_add / card_move / card_edit / card_list
// ============================================================

function cardOut_(c) {
  return {
    id: str_(c['카드ID']), project: str_(c['프로젝트']), title: str_(c['제목']), assignee: str_(c['담당']),
    status: str_(c['상태']), priority: str_(c['우선순위']), resource: str_(c['관련자원']), memo: str_(c['메모']),
    created: fmt_(c['생성시각']), updated: fmt_(c['수정시각'])
  };
}

function findCard_(cardId) {
  var t = readTable_(SHEET_BOARD);
  for (var i = 0; i < t.rows.length; i++) {
    if (str_(t.rows[i]['카드ID']) === cardId) { t.rows[i]._headers = t.headers; return t.rows[i]; }
  }
  return null;
}

/** action=card_add — project, title 필수. assignee(담당) 없으면 actor */
function addCard(p) {
  var miss = require_(p, ['project', 'title']); if (miss) return miss;
  var cfg = readCfg_();
  var bad = validate_(cfg, p, false, true); if (bad) return bad;

  var actor = str_(p.actor) || HUMAN;
  var assignee = str_(p.assignee) || actor;
  var actors = split_(cfg['행위자목록']);
  if (actors.indexOf(assignee) < 0) return { ok: false, error: 'unknown_actor', actor: assignee, actors: actors };
  var status = str_(p.status) || CARD_TODO;
  if (CARD_STATUSES.indexOf(status) < 0) return { ok: false, error: 'bad_status', statuses: CARD_STATUSES };
  var priority = str_(p.priority) || '보통';
  if (PRIORITIES.indexOf(priority) < 0) return { ok: false, error: 'bad_priority', priorities: PRIORITIES };

  var now = now_();
  var id = 'C-' + shortId_();
  sheet_(SHEET_BOARD).appendRow([id, str_(p.project), str_(p.title), assignee, status, priority, str_(p.resource), str_(p.memo), now, now]);
  log_(p.project, actor, 'card_add', str_(p.title), '담당 ' + assignee + ' · ' + status + ' · ' + priority + (str_(p.resource) ? ' · 자원 ' + str_(p.resource) : ''));
  return { ok: true, cardId: id, title: str_(p.title), status: status, assignee: assignee };
}

/** action=card_move — cardId, status 필수 */
function moveCard(p) {
  var miss = require_(p, ['cardId', 'status']); if (miss) return miss;
  var status = str_(p.status);
  if (CARD_STATUSES.indexOf(status) < 0) return { ok: false, error: 'bad_status', statuses: CARD_STATUSES };
  var c = findCard_(str_(p.cardId));
  if (!c) return { ok: false, error: 'not_found', cardId: str_(p.cardId) };

  var from = str_(c['상태']);
  setCell_(SHEET_BOARD, c._headers, c._row, '상태', status);
  setCell_(SHEET_BOARD, c._headers, c._row, '수정시각', now_());
  log_(c['프로젝트'], str_(p.actor) || HUMAN, 'card_move', str_(c['제목']), from + ' → ' + status);
  return { ok: true, cardId: str_(c['카드ID']), from: from, status: status };
}

/** action=card_edit — cardId 필수. assignee / priority / title / resource / memo 중 준 것만 바꿈 */
function editCard(p) {
  var miss = require_(p, ['cardId']); if (miss) return miss;
  var c = findCard_(str_(p.cardId));
  if (!c) return { ok: false, error: 'not_found', cardId: str_(p.cardId) };

  var changes = [];
  var map = { assignee: '담당', priority: '우선순위', title: '제목', resource: '관련자원', memo: '메모' };
  if (str_(p.priority) && PRIORITIES.indexOf(str_(p.priority)) < 0) return { ok: false, error: 'bad_priority', priorities: PRIORITIES };
  if (str_(p.assignee)) {
    var actors = split_(readCfg_()['행위자목록']);
    if (actors.indexOf(str_(p.assignee)) < 0) return { ok: false, error: 'unknown_actor', actor: str_(p.assignee), actors: actors };
  }
  Object.keys(map).forEach(function (k) {
    if (p[k] === undefined || p[k] === null) return;
    var v = str_(p[k]);
    if (k !== 'memo' && k !== 'resource' && !v) return; // 제목·담당·우선순위는 빈값 불가
    if (v === str_(c[map[k]])) return;
    setCell_(SHEET_BOARD, c._headers, c._row, map[k], v);
    changes.push(map[k] + ' ' + str_(c[map[k]]) + ' → ' + v);
  });
  if (!changes.length) return { ok: true, cardId: str_(c['카드ID']), changed: false };
  setCell_(SHEET_BOARD, c._headers, c._row, '수정시각', now_());
  log_(c['프로젝트'], str_(p.actor) || HUMAN, 'card_edit', str_(c['제목']), changes.join(' / '));
  return { ok: true, cardId: str_(c['카드ID']), changed: true, changes: changes };
}

/** action=card_list — project(선택) 필터. 전체 카드 */
function listCards(p) {
  var project = str_(p.project);
  var cards = readTable_(SHEET_BOARD).rows
    .filter(function (c) { return !project || str_(c['프로젝트']) === project; })
    .map(cardOut_);
  return { ok: true, project: project || '(전체)', cards: cards, statuses: CARD_STATUSES, priorities: PRIORITIES };
}


// ============================================================
// 5. 차례 · 일지
// ============================================================

/** action=turn — 현재차례를 actor 로 */
function passTurn(p) {
  var miss = require_(p, ['actor']); if (miss) return miss;
  var cfg = readCfg_();
  var bad = validate_(cfg, p, true, false); if (bad) return bad;
  var prev = str_(cfg['현재차례']);
  writeCfg_('현재차례', str_(p.actor));
  log_(str_(p.project), str_(p.by) || str_(p.actor), 'turn', str_(p.actor), prev + ' → ' + str_(p.actor));
  return { ok: true, turn: str_(p.actor), prev: prev };
}

/** action=log — 자유 메모 한 줄 */
function addNote(p) {
  var miss = require_(p, ['project', 'actor', 'text']); if (miss) return miss;
  log_(p.project, p.actor, 'note', str_(p.target), str_(p.text));
  return { ok: true };
}

/** action=log_list — 최근 N줄(기본 100), 최신 위. project · actor 필터 */
function listLog(p) {
  var project = str_(p.project), actor = str_(p.actor);
  var limit = num_(p.limit, 100);
  var rows = readTable_(SHEET_LOG).rows
    .filter(function (r) { return (!project || str_(r['프로젝트']) === project) && (!actor || str_(r['행위자']) === actor); })
    .map(function (r) {
      return { at: fmt_(r['일시']), project: str_(r['프로젝트']), actor: str_(r['행위자']), action: str_(r['행동']), target: str_(r['대상']), detail: str_(r['상세']) };
    });
  rows.reverse();
  return { ok: true, count: rows.length, entries: rows.slice(0, limit) };
}


// ============================================================
// 6. 지시문보관함 — guide_list / guide_get / guide_save / prompt
// ============================================================

/** 제목별 최신 버전만 (프로젝트 필터) */
function latestGuides_(project) {
  var byTitle = {};
  readTable_(SHEET_GUIDE).rows.forEach(function (r) {
    if (project && str_(r['프로젝트']) !== project) return;
    var key = str_(r['프로젝트']) + '\u0001' + /* 구분자: 이름에 못 들어가는 제어문자 */ str_(r['제목']);
    var ver = num_(r['버전'], 1);
    if (!byTitle[key] || num_(byTitle[key]['버전'], 1) < ver) byTitle[key] = r;
  });
  return Object.keys(byTitle).map(function (k) { return byTitle[k]; });
}

function guideOut_(r, withContent) {
  var o = { id: str_(r['지시문ID']), project: str_(r['프로젝트']), title: str_(r['제목']), tags: str_(r['태그']), version: num_(r['버전'], 1), updated: fmt_(r['갱신일']) };
  if (withContent) o.content = str_(r['내용']);
  return o;
}

/** action=guide_list — 최신 버전 목록 (내용 제외) */
function listGuides(p) {
  var project = str_(p.project);
  return { ok: true, guides: latestGuides_(project).map(function (r) { return guideOut_(r, false); }) };
}

/** action=guide_get — project, title 의 최신 버전 내용 */
function getGuide(p) {
  var miss = require_(p, ['project', 'title']); if (miss) return miss;
  var list = latestGuides_(str_(p.project)).filter(function (r) { return str_(r['제목']) === str_(p.title); });
  if (!list.length) return { ok: false, error: 'not_found', title: str_(p.title) };
  var o = guideOut_(list[0], true);
  o.ok = true;
  return o;
}

/** action=guide_save — 같은 제목이면 버전+1 새 행 (이전 행 유지) */
function saveGuide(p) {
  var miss = require_(p, ['project', 'title', 'content']); if (miss) return miss;
  var cfg = readCfg_();
  var bad = validate_(cfg, p, false, true); if (bad) return bad;

  var prev = latestGuides_(str_(p.project)).filter(function (r) { return str_(r['제목']) === str_(p.title); });
  var version = prev.length ? num_(prev[0]['버전'], 1) + 1 : 1;
  var id = 'G-' + shortId_();
  sheet_(SHEET_GUIDE).appendRow([id, str_(p.project), str_(p.title), str_(p.content), str_(p.tags), version, now_()]);
  log_(p.project, str_(p.actor) || HUMAN, 'guide_add', str_(p.title), 'v' + version + (str_(p.tags) ? ' · ' + str_(p.tags) : ''));
  return { ok: true, id: id, title: str_(p.title), version: version };
}

/** 에이전트 프롬프트 본문 (실제 URL·토큰 채움) */
function buildAgentPrompt(url, token, project, actor) {
  var base = url + '?token=' + token;
  return [
    '[협업 규칙 — 반드시 지킬 것]',
    '너의 이름은 "' + actor + '" 이고, 프로젝트는 "' + project + '" 이다.',
    '아래 주소는 우리가 만든 관제판 앱(구글 앱스스크립트)이다. 모델 API가 아니다. 터미널에서 curl -sL "<주소>" 로 연다.',
    '파일이나 자원을 고치기 전에 반드시:',
    '1) ' + base + '&action=status&project=' + encodeURIComponent(project) + ' 를 호출해 상태를 본다.',
    '2) 고칠 자원마다 ' + base + '&action=claim&project=' + encodeURIComponent(project) + '&resource=<경로>&actor=' + encodeURIComponent(actor) + '&memo=<한줄> 로 잠근다.',
    '   응답이 {"ok":false,"error":"locked"} 이면 그 자원은 건드리지 말고 다른 일을 하거나 사람에게 알린다.',
    '3) 작업이 길어지면 30분마다 action=heartbeat 로 연장한다. (같은 파라미터: project, resource, actor)',
    '4) 끝나면 action=release 로 놓고, action=card_move&cardId=<카드ID>&status=끝&actor=' + encodeURIComponent(actor) + ' 로 카드를 "끝"으로 옮긴다.',
    '5) 한 줄 보고는 action=log&project=' + encodeURIComponent(project) + '&actor=' + encodeURIComponent(actor) + '&text=<내용> 으로 남긴다.',
    '주소 규칙: 한글·공백이 든 값(resource, memo, text 등)은 반드시 UTF-8 퍼센트 인코딩해서 넣는다(예: 문서 → %EB%AC%B8%EC%84%9C). 응답은 JSON 한 줄이다.',
    '잠그지 않은 자원은 절대 수정하지 않는다. 자원 이름(경로)은 한 글자도 바꾸지 말고 그대로 쓴다.'
  ].join('\n');
}

/** action=prompt — project, actor 로 에이전트 프롬프트 생성 */
function agentPrompt(p) {
  var miss = require_(p, ['project', 'actor']); if (miss) return miss;
  var cfg = readCfg_();
  var bad = validate_(cfg, p, true, true); if (bad) return bad;
  var url = ScriptApp.getService().getUrl();
  return { ok: true, url: url, prompt: buildAgentPrompt(url, str_(cfg['토큰']), str_(p.project), str_(p.actor)) };
}


// ============================================================
// 7. 토론(의견) — discuss_add / discuss_list
// ============================================================
//  한 주제 아래 글로 의견을 주고받는 간단한 게시판(실시간 채팅 아님).
//  원글 밑에 답글(부모글ID로 묶임). 컬럼·응답 형식은 "다음작업_분담_토론기능.md"
//  1번 공통 계약에 고정되어 있으니 바꾸지 말 것.

/**
 * 그날 다음 순번 ID 채번 → '<letter>-<YYMMDD>-<그날 순번>' (예: D-260905-1, R-260905-1)
 * 같은 날짜 접두사를 가진 기존 ID 중 최대 순번 + 1.
 */
function nextDailyId_(sheetName, idHeader, letter, now) {
  var ymd = Utilities.formatDate(now, TZ, 'yyMMdd');
  var prefix = letter + '-' + ymd + '-';
  var max = 0;
  readTable_(sheetName).rows.forEach(function (r) {
    var id = str_(r[idHeader]);
    if (id.indexOf(prefix) !== 0) return;
    var n = num_(id.slice(prefix.length), 0);
    if (n > max) max = n;
  });
  return prefix + (max + 1);
}

/** 그날 다음 글ID → 'D-<YYMMDD>-<순번>' */
function nextDiscussId_(now) {
  return nextDailyId_(SHEET_DISCUSS, '글ID', 'D', now);
}

/** 토론 행 → 응답용 객체 (계약: id, topic, actor, text, parent, time) */
function discussOut_(r) {
  return {
    id: str_(r['글ID']), topic: str_(r['주제']), actor: str_(r['작성자']),
    text: str_(r['내용']), parent: str_(r['부모글ID']), time: fmt_(r['시각'])
  };
}

/**
 * action=discuss_add — 원글/답글 추가.
 *  필수: project, topic, actor, text  ·  선택: parent(부모글ID, 있으면 답글)
 *  응답: { ok:true, id:"D-260905-1" }
 */
function discussAdd(p) {
  var miss = require_(p, ['project', 'topic', 'actor', 'text']); if (miss) return miss;
  var cfg = readCfg_();
  var bad = validate_(cfg, p, true, true); if (bad) return bad;

  var project = str_(p.project), topic = str_(p.topic), actor = str_(p.actor), text = str_(p.text);
  var parent = str_(p.parent);
  if (parent) {
    var exists = readTable_(SHEET_DISCUSS).rows.some(function (r) { return str_(r['글ID']) === parent; });
    if (!exists) return { ok: false, error: 'parent_not_found', parent: parent };
  }

  var now = now_();
  var id = nextDiscussId_(now);
  sheet_(SHEET_DISCUSS).appendRow([id, project, topic, actor, text, parent, now]);
  log_(project, actor, 'discuss', topic, (parent ? '답글(→' + parent + ')' : '원글') + ' · ' + id);
  return { ok: true, id: id };
}

/**
 * action=discuss_list — 글 목록(시각 오름차순).
 *  필수: project  ·  선택: topic
 *  응답: { ok:true, items:[{id,topic,actor,text,parent,time}, ...] }
 */
function discussList(p) {
  var miss = require_(p, ['project']); if (miss) return miss;
  var project = str_(p.project), topic = str_(p.topic);
  var rows = readTable_(SHEET_DISCUSS).rows.filter(function (r) {
    return str_(r['프로젝트']) === project && (!topic || str_(r['주제']) === topic);
  });
  rows.sort(function (a, b) {
    var da = toDate_(a['시각']), db = toDate_(b['시각']);
    return (da ? da.getTime() : 0) - (db ? db.getTime() : 0);
  });
  return { ok: true, items: rows.map(discussOut_) };
}
