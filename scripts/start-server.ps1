$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

if (-not (Test-Path -LiteralPath "node_modules")) {
  Write-Host "node_modules not found. Run npm install first." -ForegroundColor Yellow
  exit 1
}

$env:NODE_ENV = "production"
npm run dev
