$ErrorActionPreference = "Continue"

Write-Host "Tauri packaging prerequisite check"
Write-Host "This script is read-only. It does not create folders, install Rust, install Visual Studio, or download dependencies."
Write-Host ""

Write-Host "Node:"
try {
  node --version
  npm --version
} catch {
  Write-Host "MISSING: Node.js or npm is not available on PATH."
}

Write-Host "`nRust:"
try {
  $rustcVersion = & rustc --version 2>$null
  if ($LASTEXITCODE -ne 0) { throw "rustc is not available." }
  $cargoVersion = & cargo --version 2>$null
  if ($LASTEXITCODE -ne 0) { throw "cargo is not available." }
  $activeToolchain = & rustup show active-toolchain 2>$null
  if ($LASTEXITCODE -ne 0) { throw "No active Rust toolchain is configured." }

  Write-Host $rustcVersion
  Write-Host $cargoVersion
  Write-Host $activeToolchain

  $target = & rustup target list --installed 2>$null | Select-String "x86_64-pc-windows-msvc"
  if ($target) {
    $target
  } else {
    Write-Host "MISSING: Rust target x86_64-pc-windows-msvc is not installed."
  }
} catch {
  Write-Host "MISSING: Rust, Cargo, or rustup is not available for the current environment."
  Write-Host "DETAIL: $($_.Exception.Message)"
}

Write-Host "`nMSVC cl.exe:"
$cl = Get-Command cl -ErrorAction SilentlyContinue
if ($cl) {
  $cl.Source
} else {
  Write-Host "MISSING: cl.exe is not available on PATH."
}

Write-Host "`nVisual Studio Installer:"
$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
if (Test-Path $vswhere) {
  & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
} else {
  Write-Host "MISSING: vswhere.exe was not found under Microsoft Visual Studio Installer."
}

Write-Host "`nWebView2:"
$webview = Get-ChildItem -Path "C:\Program Files (x86)\Microsoft\EdgeWebView", "C:\Program Files\Microsoft\EdgeWebView" -Recurse -Filter msedgewebview2.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if ($webview) {
  $webview.FullName
} else {
  Write-Host "MISSING: Microsoft Edge WebView2 Runtime was not found."
}

Write-Host "`nConclusion:"
Write-Host "Use this machine for tray frontend validation unless all packaging prerequisites are already present."
Write-Host "Do not install build toolchains on this workstation when following the current V5 constraint."
