param(
  [Parameter(Mandatory = $true)]
  [string]$AppBaseUrl,

  [Parameter(Mandatory = $true)]
  [string]$SecretFile,

  [string]$DeviceReference = 'ZK9500-AWS-001',
  [string]$ConfigPath = 'C:\ProgramData\LGSV_HR\ZK9500Bridge\bridge-config.json'
)

$ErrorActionPreference = 'Stop'

$appUri = [Uri]$AppBaseUrl
if ($appUri.Scheme -ne 'https') {
  throw 'AppBaseUrl must use HTTPS.'
}

if (-not (Test-Path -LiteralPath $SecretFile)) {
  throw "Biometric device secret file was not found: $SecretFile"
}

$secret = (Get-Content -Raw -LiteralPath $SecretFile).Trim()
if ($secret.Length -lt 32) {
  throw 'Biometric device secret must contain at least 32 characters.'
}

$configDirectory = Split-Path -Parent $ConfigPath
New-Item -ItemType Directory -Path $configDirectory -Force | Out-Null

if (Test-Path -LiteralPath $ConfigPath) {
  $config = Get-Content -Raw -LiteralPath $ConfigPath | ConvertFrom-Json
} else {
  $config = [pscustomobject]@{}
}

$settings = [ordered]@{
  device_reference = $DeviceReference
  hris_attendance_url = "$($appUri.GetLeftPart([System.UriPartial]::Authority))/api/biometric/station-attendance"
  auth_header_name = 'x-biometric-api-key'
  auth_secret = $secret
  background_scanner_enabled = $true
  duplicate_local_cooldown_seconds = 60
  scanner_idle_delay_ms = 600
  listener_prefix = 'http://localhost:8787/'
}

foreach ($entry in $settings.GetEnumerator()) {
  if ($config.PSObject.Properties.Name -contains $entry.Key) {
    $config.($entry.Key) = $entry.Value
  } else {
    $config | Add-Member -NotePropertyName $entry.Key -NotePropertyValue $entry.Value
  }
}

$config | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ConfigPath -Encoding UTF8

Write-Host "Biometric bridge configured for $($settings.hris_attendance_url)."
Write-Host "Device reference: $DeviceReference"
Write-Host 'The API key was written to the protected bridge config and was not printed.'
