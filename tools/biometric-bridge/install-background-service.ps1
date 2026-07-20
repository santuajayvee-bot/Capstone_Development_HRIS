$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $scriptDir 'LgsvZk9500Bridge.exe'
$taskName = 'LGSV HR ZK9500 Background Biometric Service'

if (-not (Test-Path $exe)) {
  throw "Bridge executable not found: $exe"
}

$action = New-ScheduledTaskAction -Execute $exe -WorkingDirectory $scriptDir
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description 'Runs the LGSV HR ZK9500 biometric bridge in background scanner mode.' `
  -RunLevel Highest `
  -Force | Out-Null

Start-ScheduledTask -TaskName $taskName

Write-Host "Installed and started scheduled task: $taskName"
Write-Host "Config file: $env:ProgramData\LGSV_HR\ZK9500Bridge\bridge-config.json"
Write-Host "Service log: $env:ProgramData\LGSV_HR\ZK9500Bridge\bridge-service.log"
