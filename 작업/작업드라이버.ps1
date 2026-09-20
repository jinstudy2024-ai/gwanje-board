[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$ErrorActionPreference = "Continue"

# ============================================================
#  관제판 작업 드라이버 (Windows)
#  실제 처리는 작업\작업드라이버.py 가 한다. 이 파일은 파이썬을 찾아 넘기는 껍데기다.
#  코어를 한 곳에만 두려고 이렇게 나눴다 — 두 벌로 두면 한쪽만 고쳐진다.
#  실행: powershell -ExecutionPolicy Bypass -File .\작업드라이버.ps1 [프로젝트] [once|watch]
# ============================================================

$HERE = Split-Path -Parent $MyInvocation.MyCommand.Path
$PY   = Get-Command python -ErrorAction SilentlyContinue
if (-not $PY) { $PY = Get-Command python3 -ErrorAction SilentlyContinue }

if (-not $PY) {
  Write-Host ""
  Write-Host "  X 파이썬이 없습니다." -ForegroundColor Red
  Write-Host "    -> python.org 에서 3.7 이상을 설치하세요. 설치 화면의 'Add python.exe to PATH' 를 꼭 체크하세요."
  Write-Host "    -> 설치한 뒤에는 이 창을 닫고 새로 열어야 인식됩니다."
  exit 1
}

$env:PYTHONIOENCODING = "utf-8"
& $PY.Source (Join-Path $HERE "작업드라이버.py") @args
exit $LASTEXITCODE
