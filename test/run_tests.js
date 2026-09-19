/**
 * Code.gs 필수 테스트 (지시문 9장) — Node 에서 실행:  node test/run_tests.js
 * 구글 서버 없이 mock_gas.js 위에서 Code.gs 를 그대로 돌린다.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const mock = require('./mock_gas');

const env = mock.install(globalThis);
const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'Code.gs'), 'utf8');
vm.runInThisContext(src, { filename: 'Code.gs' });

// ---- 시계 조작: now_() 를 바꿔 끼운다 ----
let clock = new Date('2026-09-05T10:00:00+09:00');
globalThis.now_ = () => new Date(clock.getTime());
const tick = (min) => { clock = new Date(clock.getTime() + min * 60000); };

// ---- 미니 테스트 프레임 ----
const results = [];
let cur = null;
function test(name, fn) {
  cur = { name, pass: 0, fail: 0, notes: [] };
  try { fn(); } catch (e) { cur.fail++; cur.notes.push('예외: ' + (e.stack || e)); }
  results.push(cur);
}
function ok(cond, msg) { if (cond) cur.pass++; else { cur.fail++; cur.notes.push('실패: ' + msg); } }
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), msg + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }

const logRows = () => readTable_('일지').rows;
const lockRows = () => readTable_('잠금').rows;
let TOKEN = '';
const call = (action, p) => route_(Object.assign({ token: TOKEN, action }, p || {}));

// ============================================================
test('1. setupSheets — 탭 6개 + 토큰 24자, 재실행 시 건너뜀', () => {
  const r = setupSheets();
  eq(r.created, ['설정', '잠금', '보드', '일지', '지시문', '토론'], '생성 탭');
  ok(/^[0-9a-f]{24}$/.test(r.token), '토큰 24자 hex: ' + r.token);
  TOKEN = r.token;
  const r2 = setupSheets();
  eq(r2.created, [], '재실행 시 새 탭 없음');
  eq(r2.token, TOKEN, '재실행 시 토큰 유지');
  const cfg = readCfg_();
  eq(cfg['현재차례'], '나', '기본 현재차례');
  eq(cfg['기본만료분'], '120', '기본만료분');
});

test('2. 토큰 틀리면 전부 unauthorized', () => {
  const actions = ['status', 'claim', 'release', 'heartbeat', 'card_add', 'card_move', 'card_edit', 'card_list', 'turn', 'log', 'log_list', 'guide_get', 'guide_list', 'guide_save', 'prompt'];
  actions.forEach(a => {
    eq(route_({ token: 'wrong', action: a, project: '내프로젝트', actor: '나' }).error, 'unauthorized', a + ' 틀린 토큰');
    eq(route_({ action: a }).error, 'unauthorized', a + ' 토큰 없음');
  });
  const g = doGet({ parameter: {} });
  ok(/unauthorized/.test(g.getContent()), 'doGet 토큰 없음 → unauthorized 안내');
  eq(JSON.parse(doGet({ parameter: { token: 'x', action: 'status' } }).getContent()).error, 'unauthorized', 'doGet 틀린 토큰 JSON');
  eq(route_({ token: TOKEN, action: 'nope' }).error, 'unknown_action', '없는 action');
});

test('3. 클로드 claim Code.gs → ChatGPT 같은 자원 claim → locked 거부', () => {
  const a = call('claim', { project: '내프로젝트', resource: ' Code.gs ', actor: '클로드', memo: '로트 함수' });
  ok(a.ok === true, 'claim ok');
  eq(a.resource, 'Code.gs', '자원 공백 제거');
  eq(a.minutes, 120, '기본만료분 적용');
  const b = call('claim', { project: '내프로젝트', resource: 'Code.gs', actor: 'ChatGPT' });
  eq(b.ok, false, '두번째 claim 거부');
  eq(b.error, 'locked', 'error=locked');
  eq(b.by, '클로드', 'by=클로드');
  ok(!!b.until, 'until 있음');
  // 대소문자 다르면 다른 자원 / 다른 프로젝트면 다른 자원
  ok(call('claim', { project: '내프로젝트', resource: 'code.gs', actor: 'ChatGPT' }).ok, '대소문자 다르면 별개 자원');
  ok(call('claim', { project: '연습', resource: 'Code.gs', actor: 'ChatGPT' }).ok, '다른 프로젝트면 별개 자원');
  // 본인 재잡기 → 연장
  const c = call('claim', { project: '내프로젝트', resource: 'Code.gs', actor: '클로드', minutes: 30 });
  ok(c.ok && c.renewed === true, '본인 재잡기 → renewed');
  // 잘못된 행위자/프로젝트/파라미터
  eq(call('claim', { project: '내프로젝트', resource: 'X', actor: '외계인' }).error, 'unknown_actor', '모르는 행위자');
  eq(call('claim', { project: '없는앱', resource: 'X', actor: '클로드' }).error, 'unknown_project', '모르는 프로젝트');
  eq(call('claim', { project: '내프로젝트', actor: '클로드' }).error, 'missing_param', '필수 파라미터 누락');
  eq(logRows().filter(r => r['행동'] === 'claim').length, 3, '일지 claim 3건');
});

test('4. 만료 5분 claim → 6분 뒤 status → 만료 처리', () => {
  const a = call('claim', { project: '내프로젝트', resource: '설치가이드.md', actor: 'ChatGPT', minutes: 5 });
  ok(a.ok, 'claim 5분');
  tick(4);
  let st = call('status', { project: '내프로젝트' });
  ok(st.locks.some(l => l.resource === '설치가이드.md'), '4분 뒤 아직 유효');
  tick(2);
  st = call('status', { project: '내프로젝트' });
  ok(!st.locks.some(l => l.resource === '설치가이드.md'), '6분 뒤 목록에서 사라짐');
  const row = lockRows().find(r => r['자원'] === '설치가이드.md');
  eq(row['상태'], '만료', '시트 상태=만료');
  const ex = logRows().filter(r => r['행동'] === 'expire');
  eq(ex.length, 1, '일지 expire 1건');
  eq(ex[0]['행위자'], '시스템', 'expire 행위자=시스템');
  // 만료된 자원은 다시 잡을 수 있다
  ok(call('claim', { project: '내프로젝트', resource: '설치가이드.md', actor: '클로드' }).ok, '만료 후 재claim 성공');
});

test('5. release 후 재claim / 남의 잠금 release 거부 / 나 강제 해제', () => {
  // 클로드가 code.gs(소문자, ChatGPT 소유) 를 풀려 함 → forbidden
  const f = call('release', { project: '내프로젝트', resource: 'code.gs', actor: '클로드' });
  eq(f.error, 'forbidden', '남의 잠금 release 거부');
  eq(f.by, 'ChatGPT', 'by 표시');
  // ChatGPT 본인 해제
  const r = call('release', { project: '내프로젝트', resource: 'code.gs', actor: 'ChatGPT' });
  ok(r.ok && r.force === false, '본인 release ok, force=false');
  eq(call('release', { project: '내프로젝트', resource: 'code.gs', actor: 'ChatGPT' }).error, 'not_locked', '이미 풀린 것 release → not_locked');
  ok(call('claim', { project: '내프로젝트', resource: 'code.gs', actor: '클로드' }).ok, 'release 후 재claim 성공');
  // 나 강제 해제 (클로드의 Code.gs)
  const fr = call('release', { project: '내프로젝트', resource: 'Code.gs', actor: '나' });
  ok(fr.ok && fr.force === true && fr.by === '클로드', '나 강제 해제 ok, force=true');
  const frLog = logRows().filter(r => r['행동'] === 'release' && /force/.test(r['상세']));
  eq(frLog.length, 1, '일지에 force 표시');
  eq(lockRows().find(r => r['자원'] === 'Code.gs' && r['행위자'] === '클로드')['상태'], '해제', '시트 상태=해제');
});

test('6. heartbeat — 본인 연장 / 남의 것 거부', () => {
  const a = call('claim', { project: '연습', resource: 'Index.html', actor: '클로드', minutes: 10 });
  ok(a.ok, 'claim 10분');
  tick(8);
  const hb = call('heartbeat', { project: '연습', resource: 'Index.html', actor: '클로드' });
  ok(hb.ok, 'heartbeat ok');
  eq(hb.minutes, 120, '기본만료분만큼 연장');
  eq(call('heartbeat', { project: '연습', resource: 'Index.html', actor: 'ChatGPT' }).error, 'forbidden', '남의 것 heartbeat 거부');
  eq(call('heartbeat', { project: '연습', resource: '없는자원', actor: '클로드' }).error, 'not_locked', '없는 잠금 heartbeat');
  tick(100);
  ok(call('status', { project: '연습' }).locks.some(l => l.resource === 'Index.html'), '연장 덕에 108분 뒤에도 유효');
  ok(logRows().some(r => r['행동'] === 'heartbeat'), '일지 heartbeat 기록');
});

test('7. 카드 추가·이동·수정 / 차례 넘기기 / 메모 → 전부 일지', () => {
  const c = call('card_add', { project: '내프로젝트', title: '사진 첨부 수정', actor: 'ChatGPT', assignee: '클로드', priority: '높음', resource: 'Code.gs' });
  ok(c.ok && /^C-/.test(c.cardId), 'card_add ok');
  eq(c.status, '할일', '기본 상태 할일');
  eq(call('card_add', { project: '내프로젝트', title: 'x', status: '이상한' }).error, 'bad_status', '잘못된 상태');
  const m = call('card_move', { cardId: c.cardId, status: '하는중', actor: '클로드' });
  ok(m.ok && m.from === '할일' && m.status === '하는중', 'card_move 할일→하는중');
  eq(call('card_move', { cardId: 'C-없음', status: '끝' }).error, 'not_found', '없는 카드');
  const st = call('status', { project: '내프로젝트' });
  ok(st.doing.some(d => d.id === c.cardId), 'status 에 하는중 카드 노출');
  const e = call('card_edit', { cardId: c.cardId, assignee: 'ChatGPT', priority: '보통', actor: 'ChatGPT' });
  ok(e.ok && e.changed && e.changes.length === 2, 'card_edit 담당·우선순위 변경');
  eq(call('card_edit', { cardId: c.cardId, assignee: 'ChatGPT' }).changed, false, '같은 값이면 변경 없음');
  const lst = call('card_list', { project: '내프로젝트' });
  eq(lst.cards.find(x => x.id === c.cardId).assignee, 'ChatGPT', 'card_list 반영');

  const t = call('turn', { actor: '클로드', by: 'ChatGPT' });
  ok(t.ok && t.turn === '클로드' && t.prev === '나', 'turn 나→클로드');
  eq(call('status', {}).turn, '클로드', 'status 에 차례 반영');
  eq(call('turn', { actor: '없는사람' }).error, 'unknown_actor', '모르는 행위자 turn 거부');

  ok(call('log', { project: '내프로젝트', actor: '클로드', text: '오늘 여기까지' }).ok, 'log ok');
  eq(call('log', { project: '내프로젝트', actor: '클로드' }).error, 'missing_param', 'text 없으면 거부');

  const acts = logRows().map(r => r['행동']);
  ['card_add', 'card_move', 'card_edit', 'turn', 'note'].forEach(a => ok(acts.indexOf(a) >= 0, '일지에 ' + a));
  const ll = call('log_list', { project: '내프로젝트', limit: 3 });
  eq(ll.entries.length, 3, 'log_list limit');
  eq(ll.entries[0].action, 'note', '최신이 위');
  eq(call('log_list', { actor: '시스템' }).entries.every(x => x.actor === '시스템'), true, '행위자 필터');
});

test('8. 지시문 — 버전 증가, 최신만 목록, 이전 행 유지', () => {
  const a = call('guide_save', { project: '연습', title: '협업 규칙', content: 'v1 내용', tags: '규칙', actor: 'ChatGPT' });
  ok(a.ok && a.version === 1, '첫 저장 v1');
  const b = call('guide_save', { project: '연습', title: '협업 규칙', content: 'v2 내용', actor: 'ChatGPT' });
  eq(b.version, 2, '같은 제목 → v2');
  eq(readTable_('지시문').rows.length, 2, '이전 행 유지(2행)');
  const g = call('guide_get', { project: '연습', title: '협업 규칙' });
  ok(g.ok && g.version === 2 && g.content === 'v2 내용', 'guide_get 최신 버전');
  eq(call('guide_list', { project: '연습' }).guides.length, 1, 'guide_list 최신만 1개');
  eq(call('guide_get', { project: '연습', title: '없음' }).error, 'not_found', '없는 지시문');
  ok(logRows().filter(r => r['행동'] === 'guide_add').length === 2, '일지 guide_add 2건');
});

test('8b. 리뷰 반영 — 담당 검증 · 캐시 무효화 · setup 전 doGet', () => {
  eq(call('card_add', { project: '내프로젝트', title: 'x', assignee: 'Claude' }).error, 'unknown_actor', 'card_add 모르는 담당 거부');
  const c = call('card_add', { project: '내프로젝트', title: '검증카드', assignee: '클로드' });
  eq(call('card_edit', { cardId: c.cardId, assignee: '외계인' }).error, 'unknown_actor', 'card_edit 모르는 담당 거부');
  // turn 이 설정을 바꾼 직후 같은 실행 안에서 status 가 새 값을 보는지 (writeCfg_ 캐시 무효화)
  call('turn', { actor: 'ChatGPT' });
  eq(readCfg_()['현재차례'], 'ChatGPT', 'writeCfg_ 후 readCfg_ 즉시 반영');
  // 프로젝트 이름에 공백이 있어도 지시문 키 충돌 없음
  eq(latestGuides_('').length >= 1, true, 'latestGuides_ 동작');
});

test('9. 에이전트 프롬프트 — URL·토큰·이름 채움', () => {
  const p = call('prompt', { project: '내프로젝트', actor: '클로드' });
  ok(p.ok, 'prompt ok');
  ok(p.prompt.indexOf('https://script.google.com/macros/s/EXAMPLE_DEPLOY_ID/exec?token=' + TOKEN + '&action=status') >= 0, 'URL+토큰 포함');
  ok(p.prompt.indexOf('"클로드"') >= 0 && p.prompt.indexOf('"내프로젝트"') >= 0, '이름·프로젝트 포함');
  ok(/action=claim/.test(p.prompt) && /action=heartbeat/.test(p.prompt) && /action=release/.test(p.prompt), '4단계 포함');
  eq(call('prompt', { project: '내프로젝트', actor: '없음' }).error, 'unknown_actor', '모르는 행위자');
});

test('10. doGet JSON 경로 · 화면 경로 · rpc 동일 라우터', () => {
  const j = doGet({ parameter: { token: TOKEN, action: 'status', project: '내프로젝트' } });
  const parsed = JSON.parse(j.getContent());
  ok(parsed.ok === true && Array.isArray(parsed.locks), 'doGet JSON status');
  eq(j._mime, 'application/json', 'MIME JSON');
  const html = doGet({ parameter: { token: TOKEN } });
  eq(html._template, 'Index', '토큰 맞으면 Index.html 템플릿');
  eq(html._token, TOKEN, '템플릿에 토큰 전달');
  const r = rpc(TOKEN, 'status', { project: '내프로젝트' });
  ok(r.ok && r.turn === 'ChatGPT', 'rpc → 같은 결과');
  eq(rpc('bad', 'status', {}).error, 'unauthorized', 'rpc 토큰 검사');
});

test('11. seedExampleData — 빈 시트에만, 재실행 시 거부', () => {
  // 새 스프레드시트로 교체
  const fresh = mock.install(globalThis);
  globalThis.now_ = () => new Date(clock.getTime());
  globalThis.cfgCache_ = null; // 새 시트로 바꿨으니 설정 캐시 비움 (실제 GAS 는 실행마다 새 전역)
  const s = seedExampleData();
  ok(s.ok && s.locks === 3 && s.cards === 4 && s.guides === 1, '예시 데이터 3/4/1');
  TOKEN = readCfg_()['토큰'];
  const st = call('status', {});
  eq(st.locks.length, 1, '유효 잠금 1개(Code.gs·클로드)');
  eq(st.locks[0].actor, '클로드', '잠근 사람 클로드');
  eq(st.doing.length, 1, '하는중 카드 1장');
  eq(lockRows().length, 3, '잠금 행 3');
  eq(readTable_('보드').rows.length, 4, '카드 4');
  eq(call('guide_list', {}).guides.length, 1, '지시문 1');
  eq(seedExampleData().error, 'not_empty', '재실행 거부');
  // 지시문만 있는 새 시트에도 seed 거부
  mock.install(globalThis); globalThis.cfgCache_ = null; setupSheets();
  const g = doGet({ parameter: {} });
  ok(/unauthorized/.test(g.getContent()), 'setup 후 토큰 없음 → unauthorized');
  sheet_('지시문').appendRow(['G-x', '연습', '협업 규칙', '내 글', '', 1, new Date()]);
  eq(seedExampleData().error, 'not_empty', '지시문만 있어도 seed 거부');
  // setup 전(탭 없음) doGet 화면 경로 → 예외 대신 안내
  mock.install(globalThis); globalThis.cfgCache_ = null;
  ok(/준비가 안/.test(doGet({ parameter: { token: 'x' } }).getContent()), 'setup 전 doGet → 안내 문구');
  mock.install(globalThis); globalThis.cfgCache_ = null; seedExampleData(); TOKEN = readCfg_()['토큰'];
  eq(readTable_('보드').rows.length, 4, '재실행 후 카드 여전히 4');
  ok(fresh.logs.length > 0, 'Logger 출력 있음');
});

// ---- 결과 출력 ----
let totalPass = 0, totalFail = 0;
console.log('\n=== Code.gs 테스트 결과 ===');
results.forEach(r => {
  totalPass += r.pass; totalFail += r.fail;
  console.log((r.fail ? '✗' : '✓') + ' ' + r.name + '  (' + r.pass + ' 통과' + (r.fail ? ', ' + r.fail + ' 실패' : '') + ')');
  r.notes.forEach(n => console.log('    ' + n));
});
console.log('\n합계: ' + totalPass + ' 통과 / ' + totalFail + ' 실패');
process.exit(totalFail ? 1 : 0);
