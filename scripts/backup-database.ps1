param(
  [string]$DatabasePath = "data\pdf-approval.sqlite",
  [string]$BackupRoot = "backups"
)

$ErrorActionPreference = "Stop"

$resolvedDatabase = Resolve-Path -LiteralPath $DatabasePath -ErrorAction SilentlyContinue
if (-not $resolvedDatabase) {
  throw "Database file not found: $DatabasePath"
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupDir = Join-Path $BackupRoot "pdf-approval-$timestamp"
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null

$sourceFiles = @(
  $resolvedDatabase.Path,
  "$($resolvedDatabase.Path)-wal",
  "$($resolvedDatabase.Path)-shm"
)

$copied = @()
foreach ($source in $sourceFiles) {
  if (Test-Path -LiteralPath $source) {
    Copy-Item -LiteralPath $source -Destination (Join-Path $backupDir (Split-Path -Leaf $source)) -Force
    $copied += (Split-Path -Leaf $source)
  }
}

if ($copied.Count -eq 0) {
  throw "No database files were copied."
}

Write-Output "Backup created: $backupDir"
Write-Output ("Files: " + ($copied -join ", "))
