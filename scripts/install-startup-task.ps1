$ErrorActionPreference = "Stop"

$TaskName = "PDFApprovalServer"
$Root = Split-Path -Parent $PSScriptRoot
$ScriptPath = Join-Path $Root "scripts\start-server.ps1"

$Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-ExecutionPolicy Bypass -File `"$ScriptPath`""
$Trigger = New-ScheduledTaskTrigger -AtLogOn
$Settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Description "Start PDF approval server after Windows login" -Force

Write-Host "Scheduled task installed: $TaskName"
