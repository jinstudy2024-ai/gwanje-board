[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$ErrorActionPreference = "Continue"

# ============================================================
#  관제판 자동토론 드라이버 (공용판, Windows PowerShell)
#
#  참가자(클로드·코덱스·헤르메스 등)를 한 명씩 불러 관제판 토론 탭에
#  한 마디씩 올리게 하고, [합의] 가 나오면 멈춘다.
#
#  실행:
#     powershell -ExecutionPolicy Bypass -File .\자동토론_드라이버.ps1
#     powershell -ExecutionPolicy Bypass -File .\자동토론_드라이버.ps1 "주제" 10
#
#  설정은 전부 같은 폴더의 자동토론.config.json 에서 읽는다.
#  (자동토론.config.example.json 을 복사해 값을 채울 것)
#
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

if (-not $TOPIC) { Write-Host "✗ 주제가 비어 있습니다. 설정의 토론.주제 를 채우거나 실행 인자로 주세요." -ForegroundColor Red; exit 1 }
if ($ROUNDS -lt 1) { $ROUNDS = 8 }

# ---- 참가자 추리기: 사용:false 제외 + CLI 설치 확인 ----
$all = @($cfg.참가자 | Where-Object { $_.사용 -ne $false -and $_.cli })
$parts = @()
foreach ($p in $all) {
  if (Get-Command $p.cli -ErrorAction SilentlyContinue) {
    $parts += $p
  } else {
    Write-Host ("↷ '{0}' 은(는) 건너뜁니다 — 명령 '{1}' 을 찾을 수 없습니다(미설치 또는 PATH 미등록)." -f $p.이름, $p.cli) -ForegroundColor Yellow
  }
}

if ($parts.Count -lt 1) {
  Write-Host "✗ 실행 가능한 참가자가 하나도 없습니다." -ForegroundColor Red
  Write-Host "  → claude / codex 같은 CLI를 설치하고 로그인한 뒤, 설정의 참가자 cli 이름과 맞는지 확인하세요."
  Write-Host "  → 점검: powershell -ExecutionPolicy Bypass -File ..\tools\점검.ps1"
  exit 1
}
if ($parts.Count -lt 2) {
  Write-Host ("⚠ 참가자가 {0}명뿐입니다. 토론이 되려면 둘 이상을 권합니다." -f $parts.Count) -ForegroundColor Yellow
}

$PROMPT_FILE = Join-Path $env:TEMP "gwanje_debate_turn.txt"   # ASCII 경로에 둬야 어느 폴더에서 실행해도 안전

function Write-Prompt($p, $round) {
  $eProject = [uri]::EscapeDataString($PROJECT)
  $eTopic   = [uri]::EscapeDataString($TOPIC)
  $eActor   = [uri]::EscapeDataString($p.이름)
  $listUrl  = "$URL`?token=$TOKEN&action=discuss_list&project=$eProject&topic=$eTopic"
  $addUrl   = "$URL`?token=$TOKEN&action=discuss_add&project=$eProject&topic=$eTopic&actor=$eActor"

  $angleLine = ""
  if ($p.관점) { $angleLine = "너의 검토 관점: " + $p.관점 }

  $refLine = ""
  if ($REFS.Count -gt 0) {
    $refLine = "[0단계] 먼저 아래 파일들을 읽고 근거로 삼아라.`n" + (($REFS | ForEach-Object { " - $_" }) -join "`n") + "`n"
  }

  $agreeLine = if ($round -le $NOAGREE) {
    "이번 라운드에서는 [합의] 를 붙이지 마라. 아직 충분히 주고받지 않았다."
  } else {
    "정말 더 논할 것이 없을 때에만 발언 맨 앞에 [합의] 를 붙이고 결론을 정리하라."
  }

  $t = @"
너는 협업 앱 "관제판"의 토론 참가자 "$($p.이름)" 이다. 자동 토론이 진행 중이고, 이번엔 딱 한 턴만 발언한다.
$angleLine

$refLine[1단계] 아래 주소로 HTTP GET 요청을 보내 지금까지의 토론 글을 읽어라 (주소를 그대로 사용):
$listUrl

[2단계] 주제 "$TOPIC" 의 흐름을 보고, 네 관점에서 "다음 한 마디"를 정해라.
 - $RULES
 - $agreeLine

[3단계] 아래 주소로 HTTP GET 요청을 보내 글을 올려라. TEXT_HERE 자리에 네 발언을 URL 인코딩해서 넣어라.
(답글이면 주소 끝에 &parent=상대의최신글ID 도 붙여라):
$addUrl&text=TEXT_HERE

끝나면 새 글ID 한 줄만 출력해라. 파일은 만들지 마라.
"@
  [IO.File]::WriteAllText($PROMPT_FILE, $t, (New-Object System.Text.UTF8Encoding($false)))
}

function Invoke-Agent($p, $readCmd) {
  switch ($p.cli) {
    "claude" {
      $a = @("-p", $readCmd, "--dangerously-skip-permissions")
      if ($p.모델) { $a += @("--model", $p.모델) }
      & claude @a
    }
    "codex" {
      $a = @("exec", "--dangerously-bypass-approvals-and-sandbox")
      if ($p.모델)     { $a += @("-m", $p.모델) }
      if ($p.추론강도) { $a += @("-c", "model_reasoning_effort=$($p.추론강도)") }
      $a += $readCmd
      & codex @a
    }
    "hermes" {
      & hermes --yolo -z $readCmd
    }
    default {
      $extra = @(); if ($p.실행인자) { $extra = @($p.실행인자) }
      & $p.cli @extra $readCmd
    }
  }
}

function Is-Agreed {
  try {
    $u = "$URL`?token=$TOKEN&action=discuss_list&project=$([uri]::EscapeDataString($PROJECT))&topic=$([uri]::EscapeDataString($TOPIC))"
    $r = Invoke-WebRequest -UseBasicParsing $u
    return ($r.Content -match '\[합의\]')
  } catch { return $false }
}

$READ = "Read the UTF-8 text file at '$PROMPT_FILE' and do exactly what it says. Reply with only the new post ID."

Write-Host "=================================================="
Write-Host " 자동토론 시작 — 주제: $TOPIC"
Write-Host (" 참가자 {0}명: {1}" -f $parts.Count, (($parts | ForEach-Object { $_.이름 }) -join ", "))
Write-Host " 최대 $ROUNDS 라운드. 관제판 앱 '토론' 탭에서 실시간으로 쌓이는 걸 보세요."
Write-Host "=================================================="

for ($i = 1; $i -le $ROUNDS; $i++) {
  Write-Host ""
  Write-Host "###### 라운드 $i / $ROUNDS ######"
  foreach ($p in $parts) {
    Write-Host ("----- {0} -----" -f $p.이름)
    Write-Prompt $p $i
    Invoke-Agent $p $READ
  }
  if (Is-Agreed) { Write-Host ">> [합의] 감지 → 토론 종료"; break }
}

Write-Host ""
Write-Host "== 끝. 앱 '토론' 탭에서 주제 `"$TOPIC`" 을 확인하세요. =="
