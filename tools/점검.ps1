[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$ErrorActionPreference = "Continue"

# ============================================================
#  관제판 설치 점검 (Windows PowerShell)
#  실행: powershell -ExecutionPolicy Bypass -File .\점검.ps1
#  무엇이 준비됐고 무엇이 비었는지 ✓/✗ 로 알려준다. 아무것도 바꾸지 않는다.
# ============================================================

$ROOT = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$ok = $true

function Line-OK($m)   { Write-Host "  ✓ $m" -ForegroundColor Green }
function Line-WARN($m) { Write-Host "  ↷ $m" -ForegroundColor Yellow }
function Line-BAD($m)  { Write-Host "  ✗ $m" -ForegroundColor Red }

Write-Host ""
Write-Host "── 관제판 설치 점검 ──"

# 1. 파이썬
Write-Host ""
Write-Host "[1] 파이썬 (작업보드 명령줄 클라이언트용)"
$py = Get-Command python -ErrorAction SilentlyContinue
if (-not $py) { $py = Get-Command python3 -ErrorAction SilentlyContinue }
if ($py) { Line-OK ("있음 — " + (& $py.Source --version 2>&1)) }
else { Line-BAD "없음 → python.org 에서 파이썬 3.7 이상 설치 (설치 시 'Add to PATH' 체크)"; $ok = $false }

# 2. AI CLI
Write-Host ""
Write-Host "[2] AI CLI (자동토론용 — 최소 둘 필요)"
$found = 0
foreach ($c in @(@("claude","클로드코드"), @("codex","코덱스"), @("hermes","헤르메스"))) {
  if (Get-Command $c[0] -ErrorAction SilentlyContinue) { Line-OK ("{0} ({1}) 있음" -f $c[1], $c[0]); $found++ }
  else { Line-WARN ("{0} ({1}) 없음 — 이 참가자는 토론에서 자동으로 빠집니다" -f $c[1], $c[0]) }
}
if ($found -lt 2) { Line-WARN "쓸 수 있는 CLI가 $found 개입니다. 자동토론에는 둘 이상을 권합니다(작업보드만 쓰는 건 지장 없음)." }

# 3. 설정 파일
Write-Host ""
Write-Host "[3] 설정 파일"
$clientCfg  = Join-Path $ROOT "client\gwanje.config.json"
$discussCfg = Join-Path $ROOT "discuss\자동토론.config.json"

if (Test-Path $clientCfg) {
  try {
    $c = Get-Content $clientCfg -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($c.url -and $c.token) { Line-OK "client\gwanje.config.json — url·token 채워짐" }
    else { Line-BAD "client\gwanje.config.json — url 또는 token 이 비었습니다"; $ok = $false }
  } catch { Line-BAD "client\gwanje.config.json — JSON 형식 오류"; $ok = $false }
} else {
  Line-WARN "client\gwanje.config.json 없음 → gwanje.config.example.json 을 복사해 만드세요"
}

if (Test-Path $discussCfg) {
  try {
    $d = Get-Content $discussCfg -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($d.관제판.url -and $d.관제판.token) { Line-OK "discuss\자동토론.config.json — url·token 채워짐" }
    else { Line-BAD "discuss\자동토론.config.json — url 또는 token 이 비었습니다" }
  } catch { Line-BAD "discuss\자동토론.config.json — JSON 형식 오류" }
} else {
  Line-WARN "discuss\자동토론.config.json 없음 → 자동토론.config.example.json 을 복사해 만드세요(자동토론 쓸 때만 필요)"
}

# 4. 관제판 연결
Write-Host ""
Write-Host "[4] 관제판 연결"
if ($py -and (Test-Path $clientCfg)) {
  Push-Location (Join-Path $ROOT "client")
  & $py.Source "gwanje_client.py" "doctor"
  Pop-Location
} else {
  Line-WARN "파이썬 또는 client\gwanje.config.json 이 준비되면 여기서 연결까지 확인합니다"
}

Write-Host ""
if ($ok) { Write-Host "점검 끝." } else { Write-Host "점검 끝 — 위의 ✗ 항목을 먼저 해결하세요." -ForegroundColor Yellow }
