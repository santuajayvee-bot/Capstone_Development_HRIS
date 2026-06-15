@echo off
cd /d "%~dp0"
echo Starting LGSV HR ZK9500 Biometric Bridge...
echo.
echo Background scanner mode starts automatically from bridge-config.json.
echo If the scanner is detected but cannot be opened, run start-bridge-admin.ps1 as Administrator.
echo Config: %ProgramData%\LGSV_HR\ZK9500Bridge\bridge-config.json
echo Log:    %ProgramData%\LGSV_HR\ZK9500Bridge\bridge-service.log
echo.
LgsvZk9500Bridge.exe
pause
