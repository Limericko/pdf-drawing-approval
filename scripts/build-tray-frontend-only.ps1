$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")

function Invoke-Step([string]$Title, [scriptblock]$Step) {
  Write-Host ""
  Write-Host "== $Title =="
  & $Step
}

Push-Location $repoRoot
try {
  Invoke-Step "Tray unit tests" {
    npm run tray:test
  }

  Invoke-Step "Tray frontend build" {
    npm --prefix apps/tray-helper run build
  }

  Write-Host ""
  Write-Host "Tray frontend validation completed without installing local Tauri build toolchains."
} finally {
  Pop-Location
}
