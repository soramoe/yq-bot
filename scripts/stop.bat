@echo off
rem Stop the service. Creates logs\service.paused so a watchdog
rem started with "start.bat auto" will not bring it back.
chcp 65001 >nul
setlocal EnableExtensions
set "ROOT=%~dp0.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"
pushd "%ROOT%" || exit /b 1

rem Prefer the portable runtime bundled with the install zip.
if exist "%ROOT%\runtime\node\node.exe" set "PATH=%ROOT%\runtime\node;%PATH%"

set "PORT=8900"
set "PID_FILE=%ROOT%\data\run.pid"
set "PAUSE_FLAG=%ROOT%\logs\service.paused"
set "PID="

REM Pause first: a watchdog tick must not restart while we are stopping.
if not exist "logs" md "logs"
echo paused>"%PAUSE_FLAG%"

if exist "%PID_FILE%" set /p PID=<"%PID_FILE%"
if defined PID (
  taskkill /f /pid %PID% >nul 2>&1
  if not errorlevel 1 echo [STOP] pid %PID%
)

REM Fallback: whoever is listening on the port.
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /r /c:":%PORT% " ^| findstr /i "LISTENING"') do (
  taskkill /f /pid %%P >nul 2>&1
)

ping 127.0.0.1 -n 3 >nul
node "scripts\health.mjs" >nul 2>&1
if errorlevel 1 (
  echo [OK] service stopped
  popd
  exit /b 0
)

echo [WARN] port %PORT% still answers. Check Task Manager or netstat -ano.
popd
exit /b 1
