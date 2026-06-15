$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $scriptDir 'LgsvZk9500Bridge.exe'

Write-Host 'Starting LGSV HR ZK9500 Biometric Bridge as Administrator...'
Start-Process -FilePath $exe -WorkingDirectory $scriptDir -Verb RunAs
