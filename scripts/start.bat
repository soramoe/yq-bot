@echo off
rem Start the service in the background (hidden window).
rem Usage: start.bat        manual start (clears the pause flag)
rem        start.bat auto   watchdog start (respects the pause flag)
chcp 65001 >nul
setlocal EnableExtensions
set "ROOT=%~dp0.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"
pushd "%ROOT%" || exit /b 1
set "PORT=8900"
set "PAUSE_FLAG=%ROOT%\logs\service.paused"
set "OUT=%ROOT%\logs\service.out.log"

if not exist "logs" md "logs"
if not exist "data" md "data"

rem Optional proxy for GitHub update checks. Put one URL in scripts\proxy.txt
rem (for example http://127.0.0.1:12450). Node 24 still needs the env switch
rem before it will route fetch through HTTP(S)_PROXY.
if exist "%ROOT%\scripts\proxy.txt" (
  set "PROXY_URL="
  for /f "usebackq delims=" %%P in ("%ROOT%\scripts\proxy.txt") do (
    if not defined PROXY_URL set "PROXY_URL=%%P"
  )
  if defined PROXY_URL (
    set "HTTP_PROXY=%PROXY_URL%"
    set "HTTPS_PROXY=%PROXY_URL%"
    set "NO_PROXY=127.0.0.1,localhost,::1"
    set "NODE_USE_ENV_PROXY=1"
    echo [INFO] using proxy from scripts\proxy.txt
  )
)

if /i "%~1"=="auto" (
  if exist "%PAUSE_FLAG%" (
    echo [SKIP] service is paused by stop.bat
    popd
    exit /b 0
  )
  if exist "%ROOT%\data\updating" (
    echo [SKIP] update is in progress
    popd
    exit /b 0
  )
) else (
  if exist "%PAUSE_FLAG%" del /q "%PAUSE_FLAG%" >nul 2>&1
  if exist "%ROOT%\data\updating" del /q "%ROOT%\data\updating" >nul 2>&1
)

node "scripts\health.mjs" >nul 2>&1
if errorlevel 3 (
  echo [FAIL] port %PORT% is used by another program
  popd
  exit /b 2
)
if not errorlevel 1 (
  echo [SKIP] already running
  popd
  exit /b 0
)

if exist "%OUT%" (
  for %%A in ("%OUT%") do if %%~zA GEQ 5242880 (
    if exist "%OUT%.1" del /q "%OUT%.1" >nul 2>&1
    move /y "%OUT%" "%OUT%.1" >nul 2>&1
  )
)

echo [START] launching node server\main.mjs
wscript //nologo "scripts\launch-hidden.vbs"
if errorlevel 1 (
  echo [FAIL] wscript could not launch the service
  popd
  exit /b 1
)

set /a TRIES=0
:WAIT
node "scripts\health.mjs" >nul 2>&1
if not errorlevel 1 goto UP
set /a TRIES+=1
if %TRIES% GEQ 30 goto FAIL
ping 127.0.0.1 -n 2 >nul
goto WAIT

:FAIL
echo [FAIL] no answer on port %PORT% after 30s. Last log lines:
powershell -NoProfile -Command "Get-Content -Tail 20 -LiteralPath '%OUT%'" 2>nul
popd
exit /b 1

:UP
echo [UP] port %PORT%
node "scripts\health.mjs" -v
popd
exit /b 0
