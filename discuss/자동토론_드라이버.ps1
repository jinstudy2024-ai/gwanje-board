[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()
$ErrorActionPreference = "Continue"

# ============================================================
#  관제판 자동토론 드라이버 (공용판, Windows PowerShell)
#
#  게시판을 읽고 쓰는 일은 전부 이 드라이버가 한다.
#  참가 AI 는 "지금까지의 토론"을 프롬프트로 받고, 자기 발언만 파일에 적는다.
#   → 한글 인코딩을 한 곳에서만 처리하므로 어느 CLI를 붙여도 글이 깨지지 않는다.
#   → 앱 주소와 토큰이 AI 에게 넘어가지 않는다.
#
#  실행:
#     powershell -ExecutionPolicy Bypass -File .\자동토론_드라이버.ps1
#     powershell -ExecutionPolicy Bypass -File .\자동토론_드라이버.ps1 "주제" 10
#
#  설정은 전부 같은 폴더의 자동토론.config.json 에서 읽는다.
#  ⚠ 모델 API 키를 쓰지 않는다. 각 CLI가 자기 구독으로 로그인돼 있어야 한다.
# ============================================================

$HERE    = Split-Path -Parent $MyInvocation.MyCommand.Path
$cfgPath = Join-Path $HERE "자동토론.config.json"

if (-not (Test-Path $cfgPath)) {
  Write-Host "✗ 설정 파일이 없습니다: $cfgPath" -ForegroundColor Red
  Write-Host "  → 같은 폴더의 '자동토론.config.example.json' 을 '자동토론.config.json' 으로 복사한 뒤"
  Write-Host "    관제판 url·token 을 채우고 다시 실행하세요. (docs/2_자동토론_붙이기.md 참고)"
  exit 1
}

try { $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json }
catch { Write-Host "✗ 설정 파일을 읽지 못했습니다(JSON 형식 오류): $_" -ForegroundColor Red; exit 1 }

$URL     = $cfg.관제판.url
$TOKEN   = $cfg.관제판.token
$PROJECT = if ($cfg.관제판.project) { $cfg.관제판.project } else { "관제판" }

if (-not $URL -or -not $TOKEN) {
  Write-Host "✗ 설정에 url 또는 token 이 비어 있습니다: $cfgPath" -ForegroundColor Red
  Write-Host "  → url 은 배포한 웹앱 주소(…/exec), token 은 구글시트 '설정' 탭의 24자리 값입니다."
  exit 1
}

$TOPIC   = if ($args.Count -ge 1) { $args[0] } else { $cfg.토론.주제 }
$ROUNDS  = if ($args.Count -ge 2) { [int]$args[1] } else { [int]$cfg.토론.라운드 }
$NOAGREE = if ($cfg.토론.합의금지_라운드) { [int]$cfg.토론.합의금지_라운드 } else { 0 }
$RULES   = $cfg.토론.발언규칙
$REFS    = @(); if ($cfg.토론.참고파일) { $REFS = @($cfg.토론.참고파일) }
$MAXPOST = 20   # 프롬프트에 넣을 최근 글 수
$MAXCALLS = if ($cfg.토론.최대호출) { [int]$cfg.토론.최대호출 } else { 30 }   # AI 호출 총 상한(안전장치)

if (-not $TOPIC) { Write-Host "✗ 주제가 비어 있습니다. 설정의 토론.주제 를 채우거나 실행 인자로 주세요." -ForegroundColor Red; exit 1 }
if ($ROUNDS -lt 1) { $ROUNDS = 8 }

# ---- 참가자 추리기: 사용:false 제외 + CLI 설치 확인 ----
$all = @($cfg.참가자 | Where-Object { $_.사용 -ne $false -and $_.cli })
$parts = @()
foreach ($p in $all) {
  if (Get-Command $p.cli -ErrorAction SilentlyContinue) { $parts += $p }
  else { Write-Host ("↷ '{0}' 은(는) 건너뜁니다 — 명령 '{1}' 을 찾을 수 없습니다(미설치 또는 PATH 미등록)." -f $p.이름, $p.cli) -ForegroundColor Yellow }
}
if ($parts.Count -lt 1) {
  Write-Host "✗ 실행 가능한 참가자가 하나도 없습니다." -ForegroundColor Red
  Write-Host "  → claude / codex 같은 CLI를 설치하고 로그인한 뒤, 설정의 참가자 cli 이름과 맞는지 확인하세요."
  Write-Host "  → 점검: powershell -ExecutionPolicy Bypass -File ..\tools\점검.ps1"
  exit 1
}
if ($parts.Count -lt 2) { Write-Host ("⚠ 참가자가 {0}명뿐입니다. 토론이 되려면 둘 이상을 권합니다." -f $parts.Count) -ForegroundColor Yellow }

$PROMPT_FILE = Join-Path $env:TEMP "gwanje_debate_turn.txt"     # ASCII 경로에 둔다
$ANSWER_FILE = Join-Path $env:TEMP "gwanje_debate_answer.txt"

# ---- 관제판 호출 (인코딩은 여기서만 처리) ----
function Api($action, $params) {
  $q = "?token=$TOKEN&action=$action"
  foreach ($k in $params.Keys) { $q += "&$k=" + [uri]::EscapeDataString([string]$params[$k]) }
  try {
    $r = Invoke-WebRequest -UseBasicParsing ($URL + $q)
    $txt = [System.Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray())
    return ($txt | ConvertFrom-Json)
  } catch {
    Write-Host ("  ✗ 관제판 통신 실패: {0}" -f $_.Exception.Message) -ForegroundColor Red
    return $null
  }
}

function Get-Thread {
  $j = Api "discuss_list" @{ project = $PROJECT; topic = $TOPIC }
  if ($null -eq $j) { return $null }
  if (-not $j.ok) {
    Write-Host ("  ✗ 목록 실패: {0}" -f $j.error) -ForegroundColor Red
    return $null
  }
  return @($j.items)
}

function Write-Prompt($p, $round, $items) {
  $thread = ""
  if ($items.Count -eq 0) {
    $thread = "(아직 아무 글도 없다. 네가 첫 발언을 한다.)"
  } else {
    $recent = $items
    if ($items.Count -gt $MAXPOST) { $recent = $items[($items.Count - $MAXPOST)..($items.Count - 1)] }
    $thread = (($recent | ForEach-Object { "── {0} ──`n{1}" -f $_.actor, $_.text }) -join "`n`n")
  }

  $angleLine = ""; if ($p.관점) { $angleLine = "너의 검토 관점: " + $p.관점 }
  $refLine = ""
  if ($REFS.Count -gt 0) {
    $refLine = "먼저 아래 파일들을 읽고 근거로 삼아라.`n" + (($REFS | ForEach-Object { " - $_" }) -join "`n") + "`n`n"
  }
  $agreeLine = if ($round -le $NOAGREE) {
    "이번 라운드에서는 [합의] 를 붙이지 마라. 아직 충분히 주고받지 않았다."
  } else {
    "정말 더 논할 것이 없을 때에만 발언 맨 앞에 [합의] 를 붙이고 결론을 정리하라."
  }

  $t = @"
너는 토론 참가자 "$($p.이름)" 이다. 주제는 "$TOPIC" 이고, 이번엔 딱 한 턴만 발언한다.
$angleLine

${refLine}[지금까지의 토론]
$thread

[할 일]
위 흐름을 읽고, 네 관점에서 "다음 한 마디"를 정해라.
 - $RULES
 - $agreeLine

[출력 방법]
네 발언 본문만 아래 파일에 UTF-8 로 저장해라. 저장이 곧 발언이다.
$ANSWER_FILE

제목·머리말·설명·따옴표 없이 발언 본문만 넣어라. 다른 파일을 만들거나 고치지 마라.
웹 요청은 하지 마라 — 게시판에 올리는 일은 드라이버가 한다.
"@
  [IO.File]::WriteAllText($PROMPT_FILE, $t, (New-Object System.Text.UTF8Encoding($false)))
}

function Invoke-Agent($p, $readCmd) {
  # 설정의 "실행인자" 는 모든 CLI에 적용된다. 프롬프트는 언제나 맨 마지막 인자.
  $extra = @(); if ($p.실행인자) { $extra = @($p.실행인자) }
  switch ($p.cli) {
    "claude" {
      $a = @("-p", $readCmd, "--dangerously-skip-permissions")
      if ($p.모델) { $a += @("--model", $p.모델) }
      $a += $extra
      & claude @a | Out-Null
    }
    "codex" {
      $a = @("exec", "--dangerously-bypass-approvals-and-sandbox")
      if ($p.모델)     { $a += @("-m", $p.모델) }
      if ($p.추론강도) { $a += @("-c", "model_reasoning_effort=$($p.추론강도)") }
      $a += $extra
      $a += $readCmd
      & codex @a | Out-Null
    }
    "hermes" {
      $a = @("--yolo", "-z") + $extra + @($readCmd)
      & hermes @a | Out-Null
    }
    default {
      & $p.cli @extra $readCmd | Out-Null
    }
  }
}

$READ = "Read the UTF-8 text file at '$PROMPT_FILE' and do exactly what it says. Write your answer to the file it names. Do not print the answer."

Write-Host "=================================================="
Write-Host " 자동토론 시작 — 주제: $TOPIC"
Write-Host (" 참가자 {0}명: {1}" -f $parts.Count, (($parts | ForEach-Object { $_.이름 }) -join ", "))
Write-Host " 최대 $ROUNDS 라운드"
$expect = $parts.Count * $ROUNDS
Write-Host (" 예상 AI 호출: {0}명 x {1}라운드 = 최대 {2}회  (상한 {3}회)" -f $parts.Count, $ROUNDS, $expect, $MAXCALLS) -ForegroundColor Cyan
if ($expect -gt $MAXCALLS) { Write-Host " ⚠ 예상이 상한을 넘습니다. 상한에 닿으면 중간에 멈춥니다(설정의 토론.최대호출)." -ForegroundColor Yellow }
Write-Host " 관제판 앱 '토론' 탭에서 실시간으로 쌓이는 걸 보세요."
Write-Host "=================================================="

$agreed = $false
$capped = $false
$calls  = 0
for ($i = 1; $i -le $ROUNDS -and -not $agreed -and -not $capped; $i++) {
  Write-Host ""
  Write-Host "###### 라운드 $i / $ROUNDS ######"

  foreach ($p in $parts) {
    if ($calls -ge $MAXCALLS) {
      Write-Host ("‖ 호출 상한 {0}회에 도달해 멈춥니다. 더 돌리려면 설정의 토론.최대호출 을 올리세요." -f $MAXCALLS) -ForegroundColor Yellow
      $capped = $true; break
    }
    Write-Host ("----- {0} -----  (호출 {1}/{2})" -f $p.이름, ($calls + 1), $MAXCALLS)

    $items = Get-Thread
    if ($null -eq $items) { Write-Host "  ↷ 게시판을 읽지 못해 이 턴을 건너뜁니다." -ForegroundColor Yellow; continue }
    $lastId = ""; if ($items.Count -gt 0) { $lastId = $items[$items.Count - 1].id }

    Remove-Item $ANSWER_FILE -Force -ErrorAction SilentlyContinue
    Write-Prompt $p $i $items
    $calls++
    Invoke-Agent $p $READ

    if (-not (Test-Path $ANSWER_FILE)) {
      Write-Host "  ↷ 발언 파일이 만들어지지 않았습니다. 이 턴은 건너뜁니다." -ForegroundColor Yellow
      continue
    }
    $ans = (Get-Content $ANSWER_FILE -Raw -Encoding UTF8)
    if ($null -eq $ans) { $ans = "" }
    $ans = $ans.Trim()
    if (-not $ans) { Write-Host "  ↷ 발언이 비어 있습니다. 이 턴은 건너뜁니다." -ForegroundColor Yellow; continue }

    $prev = $ans -replace "\s+", " "
    if ($prev.Length -gt 70) { $prev = $prev.Substring(0, 70) + "…" }
    Write-Host ("  말: {0}" -f $prev)

    $params = @{ project = $PROJECT; topic = $TOPIC; actor = $p.이름; text = $ans }
    if ($lastId) { $params["parent"] = $lastId }
    $res = Api "discuss_add" $params
    if ($res -and $res.ok) {
      Write-Host ("  ✓ 올림: {0}" -f $res.id) -ForegroundColor Green
      if ($ans -match '\[합의\]') { $agreed = $true; Write-Host ">> [합의] → 토론 종료"; break }
    } else {
      $err = if ($res) { $res.error } else { "통신 실패" }
      Write-Host ("  ✗ 올리기 실패: {0}" -f $err) -ForegroundColor Red
      if ($err -eq "unknown_actor") { Write-Host ("     → 시트 '설정' 탭 행위자목록에 '{0}' 을(를) 추가하세요." -f $p.이름) }
      if ($err -eq "unknown_project") { Write-Host ("     → 시트 '설정' 탭 프로젝트목록에 '{0}' 을(를) 추가하세요." -f $PROJECT) }
    }
  }
}

Write-Host ""
Write-Host "== 끝. 앱 '토론' 탭에서 주제 `"$TOPIC`" 을 확인하세요. =="
