$ErrorActionPreference = 'Stop'

$taskName = 'LGSV HR ZK9500 Background Biometric Service'

$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $task) {
  Write-Host "Scheduled task is not installed: $taskName"
  exit 0
}

Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false

Write-Host "Removed scheduled task: $taskName"
